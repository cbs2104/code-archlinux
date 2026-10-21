import { h, toast } from '../shared/dom'
import {
  alphaBounds,
  autoMatte,
  cleanAlpha,
  refineAlpha,
  type AlphaBounds
} from './cutout'

export interface EditorResult {
  dataUrl: string
  width: number
  height: number
}

export interface EditorStats {
  width: number
  height: number
  coverage: number
  alphaPixels: number
  edgePixels: number
  bounds: AlphaBounds | null
}

type Tool = 'rect' | 'lasso' | 'wand' | 'erase' | 'restore'
type SelectionMode = 'new' | 'add' | 'subtract'
type PreviewBackground = 'checker' | 'dark' | 'light'

interface Snapshot {
  data: ImageData
  width: number
  height: number
  source?: HTMLCanvasElement
}

const MAX_DIM = 1600
const MAX_UNDO = 10
const ALPHA_THRESHOLD = 12

export class ImageEditor {
  readonly el: HTMLElement
  private readonly stage: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly base: HTMLCanvasElement
  private readonly viewCtx: CanvasRenderingContext2D
  private readonly baseCtx: CanvasRenderingContext2D
  private readonly placeholder: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>()
  private readonly modeButtons = new Map<SelectionMode, HTMLButtonElement>()
  private readonly toleranceInput: HTMLInputElement
  private readonly brushInput: HTMLInputElement
  private readonly hardnessInput: HTMLInputElement
  private readonly autoFeatherInput: HTMLInputElement
  private readonly expandInput: HTMLInputElement
  private readonly smoothInput: HTMLInputElement
  private readonly featherInput: HTMLInputElement
  private readonly decontaminateInput: HTMLInputElement
  private readonly keepLargestInput: HTMLInputElement
  private readonly contiguousInput: HTMLInputElement
  private readonly previewSelect: HTMLSelectElement
  private readonly zoomLabel: HTMLElement
  private readonly undoBtn: HTMLButtonElement
  private readonly redoBtn: HTMLButtonElement
  private tool: Tool = 'rect'
  private selectionMode: SelectionMode = 'new'
  private previewBackground: PreviewBackground = 'checker'
  private selection: HTMLCanvasElement | null = null
  private selectionOverlay: HTMLCanvasElement | null = null
  private selectionOverlayDirty = true
  private selectionBoundsCache: AlphaBounds | null | undefined = undefined
  private drawing = false
  private startPoint: { x: number; y: number } | null = null
  private movePoint: { x: number; y: number } | null = null
  private lassoPoints: { x: number; y: number }[] = []
  private brushLast: { x: number; y: number } | null = null
  private brushStamp: HTMLCanvasElement | null = null
  private brushStampKey = ''
  private undoStack: Snapshot[] = []
  private redoStack: Snapshot[] = []
  private original: Snapshot | null = null
  private originalCanvas: HTMLCanvasElement | null = null
  private source: HTMLCanvasElement | null = null
  private imageLoaded = false
  private zoom = 1
  private previewOriginal = false
  private onChange: (() => void) | null = null

  constructor() {
    this.canvas = h('canvas', { class: 'editor-canvas' })
    this.base = document.createElement('canvas')
    this.viewCtx = this.canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D
    this.baseCtx = this.base.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D
    this.placeholder = h('div', {
      class: 'editor-placeholder',
      html: '<strong>还没有图片</strong><span>点击「选择图片」，或把图片拖进这个窗口</span>'
    })
    this.statusEl = h('span', { class: 'editor-status', text: '等待图片…' })
    this.zoomLabel = h('span', { class: 'editor-zoom-value', text: '100%' })
    this.toleranceInput = this.rangeInput(0, 150, 1, 42)
    this.brushInput = this.rangeInput(2, 180, 1, 24)
    this.hardnessInput = this.rangeInput(0, 100, 1, 80)
    this.autoFeatherInput = this.rangeInput(0, 4, 1, 1)
    this.expandInput = this.rangeInput(-4, 4, 1, 0)
    this.smoothInput = this.rangeInput(0, 12, 1, 2)
    this.featherInput = this.rangeInput(0, 12, 1, 2)
    this.decontaminateInput = this.rangeInput(0, 100, 1, 60)
    this.keepLargestInput = h('input', { type: 'checkbox', checked: true })
    this.contiguousInput = h('input', { type: 'checkbox', checked: true })
    this.previewSelect = h(
      'select',
      { class: 'input select editor-bg-select' },
      h('option', { value: 'checker', text: '棋盘格' }),
      h('option', { value: 'dark', text: '深色' }),
      h('option', { value: 'light', text: '浅色' })
    )
    this.undoBtn = h('button', {
      class: 'btn btn-ghost',
      text: '↶ 撤销',
      on: { click: () => this.undo() }
    })
    this.redoBtn = h('button', {
      class: 'btn btn-ghost',
      text: '↷ 重做',
      on: { click: () => this.redo() }
    })

    this.stage = h(
      'div',
      { class: 'editor-stage' },
      this.canvas,
      this.placeholder,
      h('div', { class: 'editor-tip', text: 'Ctrl + 滚轮缩放 · 空格看原图' }),
      this.buildZoomBar()
    )

    this.el = h(
      'div',
      { class: 'studio' },
      this.buildToolbar(),
      this.stage,
      this.buildInspector(),
      h('div', { class: 'editor-footer' }, this.statusEl)
    )

    this.canvas.hidden = true
    this.canvas.tabIndex = 0
    this.bindCanvas()
    this.bindStage()
    this.bindKeyboard()
    this.setTool('rect')
    this.setSelectionMode('new')
    this.syncButtons()
    this.applyPreviewBackground('checker')
  }

  setOnChange(cb: () => void): void {
    this.onChange = cb
  }

  private rangeInput(min: number, max: number, step: number, value: number): HTMLInputElement {
    return h('input', {
      class: 'range',
      type: 'range',
      min,
      max,
      step,
      value: String(value)
    })
  }

  private buildToolbar(): HTMLElement {
    const toolGroup = h('div', { class: 'tool-group' })
    const tools: { id: Tool; label: string; hint: string }[] = [
      { id: 'rect', label: '▭ 矩形', hint: '框选一块区域，Shift 加选 / Alt 减选' },
      { id: 'lasso', label: '✎ 套索', hint: '沿目标边缘圈选，Shift 加选 / Alt 减选' },
      { id: 'wand', label: '✨ 魔棒', hint: '按颜色生成选区，再删除或保留' },
      { id: 'erase', label: '⌫ 橡皮', hint: '软边擦除多余部分' },
      { id: 'restore', label: '↺ 恢复', hint: '用原图恢复被擦掉的部分' }
    ]
    for (const item of tools) {
      const node = h('button', {
        class: 'tool-btn',
        text: item.label,
        title: item.hint,
        on: { click: () => this.setTool(item.id) }
      })
      this.toolButtons.set(item.id, node)
      toolGroup.append(node)
    }

    const modeGroup = h('div', { class: 'tool-group editor-mode-group' })
    const modes: { id: SelectionMode; label: string; hint: string }[] = [
      { id: 'new', label: '新建', hint: '替换当前选区' },
      { id: 'add', label: '＋加选', hint: '把新区域加入选区' },
      { id: 'subtract', label: '−减选', hint: '从选区中减去新区域' }
    ]
    for (const item of modes) {
      const node = h('button', {
        class: 'tool-btn tool-btn-small',
        text: item.label,
        title: item.hint,
        on: { click: () => this.setSelectionMode(item.id) }
      })
      this.modeButtons.set(item.id, node)
      modeGroup.append(node)
    }

    return h(
      'div',
      { class: 'editor-toolbar' },
      toolGroup,
      h('span', { class: 'editor-toolbar-label', text: '选区' }),
      modeGroup,
      h('label', { class: 'inline-field' }, h('span', { text: '容差' }), this.toleranceInput),
      h('label', { class: 'inline-field' }, h('span', { text: '笔刷' }), this.brushInput),
      h('label', { class: 'inline-field' }, h('span', { text: '硬度' }), this.hardnessInput),
      h('div', { class: 'toolbar-spacer' }),
      this.undoBtn,
      this.redoBtn
    )
  }

  private buildInspector(): HTMLElement {
    return h(
      'div',
      { class: 'editor-inspector' },
      h(
        'div',
        { class: 'editor-panel' },
        h(
          'div',
          { class: 'editor-panel-head' },
          h('strong', { text: '智能抠图' }),
          h('span', { class: 'muted', text: '边缘感知 + 背景色去除' })
        ),
        h(
          'div',
          { class: 'editor-actions' },
          h('button', {
            class: 'btn btn-primary',
            text: '🪄 智能抠图',
            title: '分析四周背景色，保留主体并清理边缘',
            on: { click: () => this.autoRemoveBackground() }
          }),
          h(
            'label',
            { class: 'editor-check' },
            this.keepLargestInput,
            h('span', { text: '只保留主体' })
          ),
          h(
            'label',
            { class: 'inline-field editor-inline-slider' },
            h('span', { text: '智能羽化' }),
            this.autoFeatherInput
          ),
          h('button', {
            class: 'btn btn-ghost',
            text: '清理杂点',
            title: '删除孤立的小色块，保留主要部件',
            on: { click: () => this.cleanSpecks() }
          })
        )
      ),
      h(
        'div',
        { class: 'editor-panel' },
        h(
          'div',
          { class: 'editor-panel-head' },
          h('strong', { text: '边缘精修' }),
          h('span', { class: 'muted', text: '收缩 / 平滑 / 羽化 / 去色边' })
        ),
        h(
          'div',
          { class: 'editor-refine-grid' },
          h(
            'label',
            { class: 'editor-refine-field' },
            h('span', { text: '收缩 / 扩张' }),
            this.expandInput
          ),
          h(
            'label',
            { class: 'editor-refine-field' },
            h('span', { text: '平滑' }),
            this.smoothInput
          ),
          h(
            'label',
            { class: 'editor-refine-field' },
            h('span', { text: '羽化' }),
            this.featherInput
          ),
          h(
            'label',
            { class: 'editor-refine-field' },
            h('span', { text: '去色边' }),
            this.decontaminateInput
          )
        ),
        h(
          'div',
          { class: 'editor-actions' },
          h('button', {
            class: 'btn btn-secondary',
            text: '应用精修',
            title: '按当前参数处理透明边缘；可撤销',
            on: { click: () => this.applyRefine() }
          }),
          h('button', {
            class: 'btn btn-ghost',
            text: '只看去色边',
            on: { click: () => this.applyRefine(true) }
          })
        )
      ),
      h(
        'div',
        { class: 'editor-panel' },
        h(
          'div',
          { class: 'editor-panel-head' },
          h('strong', { text: '选区' }),
          h('span', { class: 'muted', text: '支持矩形 / 套索 / 魔棒组合' })
        ),
        h(
          'div',
          { class: 'editor-actions' },
          h('button', {
            class: 'btn btn-secondary',
            text: '保留选区',
            on: { click: () => this.keepSelection(false) }
          }),
          h('button', {
            class: 'btn btn-secondary',
            text: '删除选区',
            on: { click: () => this.deleteSelection() }
          }),
          h('button', {
            class: 'btn btn-secondary',
            text: '裁剪到选区',
            on: { click: () => this.cropSelection() }
          }),
          h('button', {
            class: 'btn btn-ghost',
            text: '反选保留',
            on: { click: () => this.keepSelection(true) }
          })
        ),
        h(
          'label',
          { class: 'editor-check' },
          this.contiguousInput,
          h('span', { text: '魔棒只选择连续区域（关闭后全图同色一起选）' })
        )
      ),
      h(
        'div',
        { class: 'editor-panel editor-panel-compact' },
        h(
          'div',
          { class: 'editor-actions' },
          h(
            'label',
            { class: 'inline-field' },
            h('span', { text: '预览背景' }),
            this.previewSelect
          ),
          h('button', {
            class: 'btn btn-ghost',
            text: '原图对比',
            title: '切换查看未修改的原始图片',
            on: {
              click: (event) => {
                this.previewOriginal = !this.previewOriginal
                ;(event.currentTarget as HTMLButtonElement).classList.toggle(
                  'active',
                  this.previewOriginal
                )
                this.render()
                this.updateStatus()
              }
            }
          }),
          h('button', {
            class: 'btn btn-ghost',
            text: '裁剪空白',
            on: { click: () => this.trimToContent() }
          }),
          h('button', {
            class: 'btn btn-ghost',
            text: '↺ 还原原图',
            on: { click: () => this.reset() }
          })
        )
      )
    )
  }

  private setTool(tool: Tool): void {
    this.tool = tool
    this.toolButtons.forEach((node, key) => node.classList.toggle('active', key === tool))
    this.canvas.style.cursor = tool === 'erase' || tool === 'restore' ? 'none' : 'crosshair'
    this.updateStatus()
  }

  private setSelectionMode(mode: SelectionMode): void {
    this.selectionMode = mode
    this.modeButtons.forEach((node, key) => node.classList.toggle('active', key === mode))
  }

  private buildZoomBar(): HTMLElement {
    return h(
      'div',
      { class: 'editor-zoom-bar' },
      h('button', {
        class: 'editor-zoom-btn',
        text: '−',
        title: '缩小',
        on: { click: () => this.setZoom(this.zoom / 1.2) }
      }),
      this.zoomLabel,
      h('button', {
        class: 'editor-zoom-btn',
        text: '＋',
        title: '放大',
        on: { click: () => this.setZoom(this.zoom * 1.2) }
      }),
      h('button', {
        class: 'editor-zoom-btn editor-zoom-fit',
        text: '适应',
        title: '适应编辑区',
        on: { click: () => this.fitView() }
      })
    )
  }

  private bindStage(): void {
    this.stage.addEventListener(
      'wheel',
      (event) => {
        if (!this.imageLoaded || !(event.ctrlKey || event.metaKey)) return
        event.preventDefault()
        const factor = event.deltaY < 0 ? 1.14 : 1 / 1.14
        this.setZoom(this.zoom * factor)
      },
      { passive: false }
    )
    this.previewSelect.addEventListener('change', () => {
      this.applyPreviewBackground(this.previewSelect.value as PreviewBackground)
    })
  }

  private bindKeyboard(): void {
    window.addEventListener('keydown', (event) => {
      if (!this.imageLoaded || !this.el.isConnected) return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const key = event.key.toLowerCase()
      const command = event.ctrlKey || event.metaKey
      if (command && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) this.redo()
        else this.undo()
        return
      }
      if (command && key === 'y') {
        event.preventDefault()
        this.redo()
        return
      }
      if ((key === 'delete' || key === 'backspace') && this.selection) {
        event.preventDefault()
        this.deleteSelection()
        return
      }
      if (key === ' ') {
        event.preventDefault()
        if (!this.previewOriginal) {
          this.previewOriginal = true
          this.render()
        }
        return
      }
      if (key === 'escape') {
        this.clearSelection()
        this.render()
        this.updateStatus()
        return
      }
      if (key === '[' || key === ']') {
        event.preventDefault()
        const next = Math.min(
          180,
          Math.max(2, Number(this.brushInput.value) + (key === ']' ? 2 : -2))
        )
        this.brushInput.value = String(next)
        this.render()
        return
      }
      const toolKeys: Record<string, Tool> = {
        '1': 'rect',
        '2': 'lasso',
        '3': 'wand',
        '4': 'erase',
        '5': 'restore'
      }
      if (toolKeys[key]) this.setTool(toolKeys[key])
      if (key === '0') {
        event.preventDefault()
        this.fitView()
      }
      if (key === '+' || key === '=') {
        event.preventDefault()
        this.setZoom(this.zoom * 1.2)
      }
      if (key === '-') {
        event.preventDefault()
        this.setZoom(this.zoom / 1.2)
      }
    })
    window.addEventListener('keyup', (event) => {
      if (event.key === ' ' && this.previewOriginal) {
        this.previewOriginal = false
        this.render()
        this.updateStatus()
      }
    })
  }

  private toImagePoint(event: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * this.base.width
    const y = ((event.clientY - rect.top) / Math.max(1, rect.height)) * this.base.height
    return {
      x: Math.min(this.base.width - 1, Math.max(0, Math.round(x))),
      y: Math.min(this.base.height - 1, Math.max(0, Math.round(y)))
    }
  }

  private resolveMode(event: PointerEvent): SelectionMode {
    if (event.altKey) return 'subtract'
    if (event.shiftKey) return 'add'
    return this.selectionMode
  }

  async load(dataUrl: string): Promise<void> {
    const image = new Image()
    image.src = dataUrl
    try {
      await image.decode()
    } catch {
      throw new Error('这张图片无法解码，请换一张 PNG / JPG')
    }
    const scale = Math.min(1, MAX_DIM / Math.max(image.width || 1, image.height || 1))
    const width = Math.max(1, Math.round((image.width || 1) * scale))
    const height = Math.max(1, Math.round((image.height || 1) * scale))
    this.base.width = width
    this.base.height = height
    this.baseCtx.clearRect(0, 0, width, height)
    this.baseCtx.drawImage(image, 0, 0, width, height)
    this.canvas.width = width
    this.canvas.height = height
    this.canvas.hidden = false
    this.placeholder.classList.add('hidden')
    this.undoStack = []
    this.redoStack = []
    this.clearSelection(false)
    this.imageLoaded = true
    this.previewOriginal = false
    this.original = this.snapshot()
    this.originalCanvas = this.copyCanvas(this.base)
    this.source = this.copyCanvas(this.base)
    this.zoom = 1
    this.render()
    this.updateStatus()
    this.syncButtons()
    window.requestAnimationFrame(() => this.fitView())
    this.onChange?.()
  }

  private snapshot(): Snapshot {
    return {
      data: this.baseCtx.getImageData(0, 0, this.base.width, this.base.height),
      width: this.base.width,
      height: this.base.height,
      source: this.source ?? undefined
    }
  }

  private copyCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
    const copy = document.createElement('canvas')
    copy.width = source.width
    copy.height = source.height
    copy.getContext('2d')?.drawImage(source, 0, 0)
    return copy
  }

  private restore(snapshot: Snapshot): void {
    this.base.width = snapshot.width
    this.base.height = snapshot.height
    this.canvas.width = snapshot.width
    this.canvas.height = snapshot.height
    this.baseCtx.putImageData(snapshot.data, 0, 0)
    this.clearSelection(false)
    if (snapshot.source) {
      this.source = snapshot.source
    } else if (
      this.original &&
      snapshot.width === this.original.width &&
      snapshot.height === this.original.height
    ) {
      this.source = this.canvasFromImageData(this.original.data)
    }
    this.render()
    this.updateStatus()
    window.requestAnimationFrame(() => this.fitView())
  }

  private canvasFromImageData(data: ImageData): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    canvas.width = data.width
    canvas.height = data.height
    canvas.getContext('2d')?.putImageData(data, 0, 0)
    return canvas
  }

  private pushUndo(): void {
    if (!this.imageLoaded) return
    this.undoStack.push(this.snapshot())
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift()
    this.redoStack = []
    this.syncButtons()
  }

  undo(): void {
    const snapshot = this.undoStack.pop()
    if (!snapshot) return
    this.redoStack.push(this.snapshot())
    this.restore(snapshot)
    this.syncButtons()
    this.onChange?.()
  }

  redo(): void {
    const snapshot = this.redoStack.pop()
    if (!snapshot) return
    this.undoStack.push(this.snapshot())
    this.restore(snapshot)
    this.syncButtons()
    this.onChange?.()
  }

  reset(): void {
    if (!this.original) return
    this.base.width = this.original.width
    this.base.height = this.original.height
    this.canvas.width = this.original.width
    this.canvas.height = this.original.height
    this.baseCtx.putImageData(this.original.data, 0, 0)
    this.source = this.canvasFromImageData(this.original.data)
    this.originalCanvas = this.canvasFromImageData(this.original.data)
    this.undoStack = []
    this.redoStack = []
    this.clearSelection(false)
    this.previewOriginal = false
    this.render()
    this.updateStatus()
    this.syncButtons()
    window.requestAnimationFrame(() => this.fitView())
    this.onChange?.()
  }

  private commit(): void {
    this.selectionOverlayDirty = true
    this.render()
    this.updateStatus()
    this.syncButtons()
    this.onChange?.()
  }

  private syncButtons(): void {
    this.undoBtn.disabled = this.undoStack.length === 0
    this.redoBtn.disabled = this.redoStack.length === 0
  }

  private bindCanvas(): void {
    this.canvas.addEventListener('pointerdown', (event) => {
      if (!this.imageLoaded || event.button !== 0) return
      event.preventDefault()
      this.canvas.focus()
      try {
        this.canvas.setPointerCapture(event.pointerId)
      } catch {
        /* ignore */
      }
      const point = this.toImagePoint(event)
      const mode = this.resolveMode(event)
      this.startPoint = point
      this.movePoint = point
      if (this.tool === 'wand') {
        this.applyWand(point, Number(this.toleranceInput.value), mode)
        this.startPoint = null
        return
      }
      if (this.tool === 'erase' || this.tool === 'restore') {
        if (this.tool === 'restore' && !this.canRestore()) {
          toast('原图暂不可用，请先还原原图后再试', 'error')
          return
        }
        this.pushUndo()
        this.drawing = true
        this.brushLast = point
        this.paintBrush(point, point)
        this.commit()
        return
      }
      this.drawing = true
      if (mode === 'new') this.clearSelection(false)
      if (this.tool === 'lasso') this.lassoPoints = [point]
      this.render()
    })

    this.canvas.addEventListener('pointermove', (event) => {
      if (!this.imageLoaded) return
      const point = this.toImagePoint(event)
      this.movePoint = point
      if (!this.drawing) {
        if (this.tool === 'erase' || this.tool === 'restore') this.render()
        return
      }
      if (this.tool === 'erase' || this.tool === 'restore') {
        const last = this.brushLast ?? point
        this.paintBrush(last, point)
        this.brushLast = point
        this.commit()
        return
      }
      if (this.tool === 'lasso') {
        const last = this.lassoPoints[this.lassoPoints.length - 1]
        if (!last || Math.hypot(last.x - point.x, last.y - point.y) > 1.5) {
          this.lassoPoints.push(point)
        }
      }
      this.render()
    })

    const finish = (event: PointerEvent): void => {
      if (!this.drawing || !this.imageLoaded) return
      try {
        this.canvas.releasePointerCapture(event.pointerId)
      } catch {
        /* ignore */
      }
      this.drawing = false
      if (this.tool === 'rect' && this.startPoint && this.movePoint) {
        const path = new Path2D()
        const x = Math.min(this.startPoint.x, this.movePoint.x)
        const y = Math.min(this.startPoint.y, this.movePoint.y)
        const width = Math.abs(this.movePoint.x - this.startPoint.x)
        const height = Math.abs(this.movePoint.y - this.startPoint.y)
        if (width > 3 && height > 3) {
          path.rect(x, y, width, height)
          this.applyPathSelection(path, this.resolveMode(event))
        }
      } else if (this.tool === 'lasso' && this.lassoPoints.length > 3) {
        const path = new Path2D()
        path.moveTo(this.lassoPoints[0].x, this.lassoPoints[0].y)
        for (let i = 1; i < this.lassoPoints.length; i += 1) {
          path.lineTo(this.lassoPoints[i].x, this.lassoPoints[i].y)
        }
        path.closePath()
        this.applyPathSelection(path, this.resolveMode(event))
      }
      this.startPoint = null
      this.lassoPoints = []
      this.brushLast = null
      this.render()
      this.updateStatus()
      this.onChange?.()
    }
    this.canvas.addEventListener('pointerup', finish)
    this.canvas.addEventListener('pointercancel', finish)
    this.canvas.addEventListener('pointerleave', () => {
      if (!this.drawing) {
        this.movePoint = null
        this.render()
      }
    })
    this.canvas.addEventListener('contextmenu', (event) => event.preventDefault())
  }

  private ensureSelection(): HTMLCanvasElement {
    if (
      !this.selection ||
      this.selection.width !== this.base.width ||
      this.selection.height !== this.base.height
    ) {
      this.selection = document.createElement('canvas')
      this.selection.width = this.base.width
      this.selection.height = this.base.height
      this.selectionOverlayDirty = true
      this.selectionBoundsCache = undefined
    }
    return this.selection
  }

  private clearSelection(renderNow = true): void {
    this.selection = null
    this.selectionOverlay = null
    this.selectionOverlayDirty = true
    this.selectionBoundsCache = undefined
    if (renderNow) {
      this.render()
      this.updateStatus()
    }
  }

  private applyPathSelection(path: Path2D, mode: SelectionMode): void {
    const mask = this.ensureSelection()
    const ctx = mask.getContext('2d') as CanvasRenderingContext2D
    if (mode === 'new') ctx.clearRect(0, 0, mask.width, mask.height)
    ctx.save()
    ctx.globalCompositeOperation = mode === 'subtract' ? 'destination-out' : 'source-over'
    ctx.fillStyle = '#fff'
    ctx.fill(path)
    ctx.restore()
    this.selectionOverlayDirty = true
    this.selectionBoundsCache = undefined
  }

  private applyWand(
    point: { x: number; y: number },
    tolerance: number,
    mode: SelectionMode
  ): void {
    const mask = this.wandMask(point, tolerance, this.contiguousInput.checked)
    if (!mask) {
      toast('这里没有可选择的像素', 'info')
      return
    }
    this.applySelectionMaskPixels(mask, mode)
    this.render()
    this.updateStatus()
    this.onChange?.()
  }

  private applySelectionMaskPixels(mask: Uint8Array, mode: SelectionMode): void {
    const selection = this.ensureSelection()
    const temp = document.createElement('canvas')
    temp.width = this.base.width
    temp.height = this.base.height
    const tempCtx = temp.getContext('2d') as CanvasRenderingContext2D
    const image = tempCtx.createImageData(temp.width, temp.height)
    for (let i = 0; i < mask.length; i += 1) {
      if (!mask[i]) continue
      image.data[i * 4] = 255
      image.data[i * 4 + 1] = 255
      image.data[i * 4 + 2] = 255
      image.data[i * 4 + 3] = 255
    }
    tempCtx.putImageData(image, 0, 0)
    const ctx = selection.getContext('2d') as CanvasRenderingContext2D
    if (mode === 'new') ctx.clearRect(0, 0, selection.width, selection.height)
    ctx.save()
    ctx.globalCompositeOperation = mode === 'subtract' ? 'destination-out' : 'source-over'
    ctx.drawImage(temp, 0, 0)
    ctx.restore()
    this.selectionOverlayDirty = true
    this.selectionBoundsCache = undefined
  }

  private wandMask(
    point: { x: number; y: number },
    tolerance: number,
    contiguous: boolean
  ): Uint8Array | null {
    const width = this.base.width
    const height = this.base.height
    const start = point.y * width + point.x
    if (start < 0 || start >= width * height) return null
    const image = this.baseCtx.getImageData(0, 0, width, height)
    const data = image.data
    const startOffset = start * 4
    if (data[startOffset + 3] < 4) return null
    const sr = data[startOffset]
    const sg = data[startOffset + 1]
    const sb = data[startOffset + 2]
    const limit = Math.max(0, tolerance)
    const mask = new Uint8Array(width * height)
    const matches = (offset: number): boolean => {
      if (data[offset + 3] < 4) return false
      const dr = data[offset] - sr
      const dg = data[offset + 1] - sg
      const db = data[offset + 2] - sb
      return Math.sqrt((2 * dr * dr + 4 * dg * dg + 3 * db * db) / 9) <= limit
    }
    if (!contiguous) {
      for (let index = 0; index < width * height; index += 1) {
        if (matches(index * 4)) mask[index] = 1
      }
      return mask
    }
    const queue = new Uint32Array(width * height)
    let head = 0
    let tail = 0
    mask[start] = 1
    queue[tail++] = start
    while (head < tail) {
      const index = queue[head++]
      if (!matches(index * 4)) continue
      const x = index % width
      const y = (index / width) | 0
      const neighbours = [
        x > 0 ? index - 1 : -1,
        x < width - 1 ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y < height - 1 ? index + width : -1
      ]
      for (const next of neighbours) {
        if (next < 0 || mask[next] || !matches(next * 4)) continue
        mask[next] = 1
        queue[tail++] = next
      }
    }
    return mask
  }

  private selectionBounds(): AlphaBounds | null {
    if (!this.selection) return null
    if (this.selectionBoundsCache !== undefined) return this.selectionBoundsCache
    const ctx = this.selection.getContext('2d') as CanvasRenderingContext2D
    const bounds = alphaBounds(
      ctx.getImageData(0, 0, this.selection.width, this.selection.height).data,
      this.selection.width,
      this.selection.height,
      8
    )
    this.selectionBoundsCache = bounds
    return bounds
  }

  private canRestore(): boolean {
    return (
      !!this.source &&
      this.source.width === this.base.width &&
      this.source.height === this.base.height
    )
  }

  private brushRadius(): number {
    return Math.max(1, Number(this.brushInput.value) / 2)
  }

  private brushStampFor(radius: number): HTMLCanvasElement {
    const hardness = Math.min(1, Math.max(0, Number(this.hardnessInput.value) / 100))
    const key = `${Math.round(radius * 10)}:${Math.round(hardness * 100)}`
    if (this.brushStamp && this.brushStampKey === key) return this.brushStamp
    const diameter = Math.ceil(radius * 2) + 2
    const stamp = document.createElement('canvas')
    stamp.width = diameter
    stamp.height = diameter
    const ctx = stamp.getContext('2d') as CanvasRenderingContext2D
    const center = diameter / 2
    ctx.fillStyle = '#fff'
    if (hardness >= 0.99) {
      ctx.beginPath()
      ctx.arc(center, center, radius, 0, Math.PI * 2)
      ctx.fill()
    } else {
      const gradient = ctx.createRadialGradient(
        center,
        center,
        Math.max(0, radius * hardness),
        center,
        center,
        radius
      )
      gradient.addColorStop(0, 'rgba(255,255,255,1)')
      gradient.addColorStop(0.82, 'rgba(255,255,255,0.85)')
      gradient.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, diameter, diameter)
    }
    this.brushStamp = stamp
    this.brushStampKey = key
    return stamp
  }

  private paintBrush(from: { x: number; y: number }, to: { x: number; y: number }): void {
    const radius = this.brushRadius()
    const distance = Math.hypot(to.x - from.x, to.y - from.y)
    const spacing = Math.max(1, radius * 0.3)
    const steps = Math.max(1, Math.ceil(distance / spacing))
    for (let step = 0; step <= steps; step += 1) {
      const t = steps === 0 ? 0 : step / steps
      this.stampBrush(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, radius)
    }
  }

  private stampBrush(x: number, y: number, radius: number): void {
    const stamp = this.brushStampFor(radius)
    const dx = Math.round(x - stamp.width / 2)
    const dy = Math.round(y - stamp.height / 2)
    if (this.tool === 'erase') {
      const ctx = this.baseCtx
      ctx.save()
      ctx.globalCompositeOperation = 'destination-out'
      ctx.drawImage(stamp, dx, dy)
      ctx.restore()
      return
    }
    if (!this.source) return
    const temp = document.createElement('canvas')
    temp.width = stamp.width
    temp.height = stamp.height
    const tctx = temp.getContext('2d') as CanvasRenderingContext2D
    tctx.drawImage(this.source, dx, dy, stamp.width, stamp.height, 0, 0, stamp.width, stamp.height)
    tctx.globalCompositeOperation = 'destination-in'
    tctx.drawImage(stamp, 0, 0)
    this.baseCtx.drawImage(temp, dx, dy)
  }

  private selectionOverlayForRender(): HTMLCanvasElement | null {
    if (!this.selection) return null
    if (this.selectionOverlay && !this.selectionOverlayDirty) return this.selectionOverlay
    const overlay = document.createElement('canvas')
    overlay.width = this.base.width
    overlay.height = this.base.height
    const ctx = overlay.getContext('2d') as CanvasRenderingContext2D
    ctx.fillStyle = 'rgba(4, 7, 14, 0.42)'
    ctx.fillRect(0, 0, overlay.width, overlay.height)
    ctx.globalCompositeOperation = 'destination-out'
    ctx.drawImage(this.selection, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    const accent = document.createElement('canvas')
    accent.width = overlay.width
    accent.height = overlay.height
    const actx = accent.getContext('2d') as CanvasRenderingContext2D
    actx.drawImage(this.selection, 0, 0)
    actx.globalCompositeOperation = 'source-in'
    actx.fillStyle = 'rgba(255, 154, 134, 0.2)'
    actx.fillRect(0, 0, accent.width, accent.height)
    ctx.drawImage(accent, 0, 0)
    this.selectionOverlay = overlay
    this.selectionOverlayDirty = false
    return overlay
  }

  private dragPath(): Path2D | null {
    if (!this.drawing || !this.startPoint || !this.movePoint) return null
    if (this.tool === 'rect') {
      const path = new Path2D()
      path.rect(
        Math.min(this.startPoint.x, this.movePoint.x),
        Math.min(this.startPoint.y, this.movePoint.y),
        Math.abs(this.movePoint.x - this.startPoint.x),
        Math.abs(this.movePoint.y - this.startPoint.y)
      )
      return path
    }
    if (this.tool === 'lasso' && this.lassoPoints.length > 1) {
      const path = new Path2D()
      path.moveTo(this.lassoPoints[0].x, this.lassoPoints[0].y)
      for (let i = 1; i < this.lassoPoints.length; i += 1) {
        path.lineTo(this.lassoPoints[i].x, this.lassoPoints[i].y)
      }
      return path
    }
    return null
  }

  private render(): void {
    if (!this.imageLoaded) return
    const ctx = this.viewCtx
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    if (this.previewOriginal && this.originalCanvas) {
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(this.originalCanvas, 0, 0, this.canvas.width, this.canvas.height)
    } else {
      ctx.drawImage(this.base, 0, 0)
      const overlay = this.selectionOverlayForRender()
      if (overlay) ctx.drawImage(overlay, 0, 0)
      const path = this.dragPath()
      if (path) {
        ctx.save()
        ctx.fillStyle = 'rgba(255, 154, 134, 0.16)'
        ctx.fill(path)
        ctx.lineWidth = Math.max(1, this.canvas.width / 900)
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)'
        ctx.setLineDash([7, 5])
        ctx.stroke(path)
        ctx.restore()
      }
      if (
        this.movePoint &&
        (this.tool === 'erase' || this.tool === 'restore') &&
        !this.previewOriginal
      ) {
        ctx.save()
        ctx.lineWidth = Math.max(1, this.canvas.width / 700)
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
        ctx.beginPath()
        ctx.arc(this.movePoint.x, this.movePoint.y, this.brushRadius(), 0, Math.PI * 2)
        ctx.stroke()
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)'
        ctx.lineWidth += 1
        ctx.beginPath()
        ctx.arc(this.movePoint.x, this.movePoint.y, this.brushRadius() + 1, 0, Math.PI * 2)
        ctx.stroke()
        ctx.restore()
      }
    }
  }

  private applyPreviewBackground(mode: PreviewBackground): void {
    this.previewBackground = mode
    this.stage.dataset.preview = mode
    this.stage.classList.toggle('preview-dark', mode === 'dark')
    this.stage.classList.toggle('preview-light', mode === 'light')
  }

  private setZoom(value: number): void {
    if (!this.imageLoaded) return
    this.zoom = Math.min(4, Math.max(0.25, value))
    this.canvas.style.width = `${Math.max(1, Math.round(this.base.width * this.zoom))}px`
    this.canvas.style.height = `${Math.max(1, Math.round(this.base.height * this.zoom))}px`
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`
    this.updateStatus()
  }

  private fitView(): void {
    if (!this.imageLoaded) return
    const availableWidth = Math.max(160, this.stage.clientWidth - 24)
    const availableHeight = Math.min(480, Math.max(240, this.stage.clientHeight - 24))
    const scale = Math.min(
      availableWidth / this.base.width,
      availableHeight / this.base.height,
      1
    )
    this.setZoom(scale || 1)
  }

  private updateStatus(): void {
    if (!this.imageLoaded) {
      this.statusEl.textContent = '等待图片…'
      return
    }
    const selection = this.selectionBounds()
    const selectionInfo = selection
      ? ` · 选区 ${Math.round(selection.width)}×${Math.round(selection.height)}`
      : ''
    const mode = this.previewOriginal ? ' · 原图' : ''
    this.statusEl.textContent = `画布 ${this.base.width}×${this.base.height} · 缩放 ${Math.round(this.zoom * 100)}% · ${this.toolLabel()}${selectionInfo}${mode}`
  }

  private alphaBounds(): AlphaBounds | null {
    if (!this.imageLoaded) return null
    return alphaBounds(
      this.baseCtx.getImageData(0, 0, this.base.width, this.base.height).data,
      this.base.width,
      this.base.height
    )
  }

  private toolLabel(): string {
    switch (this.tool) {
      case 'rect':
        return '矩形选框'
      case 'lasso':
        return '套索'
      case 'wand':
        return '魔棒'
      case 'erase':
        return '橡皮'
      case 'restore':
        return '恢复画笔'
    }
  }

  autoRemoveBackground(): void {
    if (!this.imageLoaded) return
    this.pushUndo()
    const image = this.baseCtx.getImageData(0, 0, this.base.width, this.base.height)
    const stats = autoMatte(image.data, this.base.width, this.base.height, {
      tolerance: Number(this.toleranceInput.value),
      keepLargest: this.keepLargestInput.checked,
      feather: Number(this.autoFeatherInput.value),
      decontaminate: 60
    })
    this.baseCtx.putImageData(image, 0, 0)
    this.clearSelection(false)
    const bounds = this.alphaBounds()
    if (bounds) {
      this.cropTo(bounds.x, bounds.y, bounds.width, bounds.height, false)
    }
    this.commit()
    toast(
      stats.keptPixels > 0
        ? `抠图完成：保留 ${stats.keptPixels.toLocaleString()} 像素，柔化边缘 ${stats.edgePixels.toLocaleString()} 像素`
        : '没有检测到主体，请换一张背景更干净的图片',
      stats.keptPixels > 0 ? 'success' : 'error',
      3200
    )
  }

  cleanSpecks(): void {
    if (!this.imageLoaded) return
    this.pushUndo()
    const image = this.baseCtx.getImageData(0, 0, this.base.width, this.base.height)
    const stats = cleanAlpha(
      image.data,
      this.base.width,
      this.base.height,
      this.keepLargestInput.checked
    )
    this.baseCtx.putImageData(image, 0, 0)
    this.commit()
    toast(`已清理杂点，保留 ${stats.keptPixels.toLocaleString()} 像素`, 'info')
  }

  private applyRefine(onlyDecontaminate = false): void {
    if (!this.imageLoaded) return
    this.pushUndo()
    const image = this.baseCtx.getImageData(0, 0, this.base.width, this.base.height)
    const stats = refineAlpha(image.data, this.base.width, this.base.height, {
      expand: onlyDecontaminate ? 0 : Number(this.expandInput.value),
      smooth: onlyDecontaminate ? 0 : Number(this.smoothInput.value),
      feather: onlyDecontaminate ? 0 : Number(this.featherInput.value),
      decontaminate: Number(this.decontaminateInput.value)
    })
    this.baseCtx.putImageData(image, 0, 0)
    this.commit()
    toast(
      `边缘精修完成：${stats.edgePixels.toLocaleString()} 个柔化边缘像素`,
      'success'
    )
  }

  private deleteSelection(): void {
    if (!this.selection) {
      toast('请先用矩形、套索或魔棒创建选区', 'info')
      return
    }
    this.pushUndo()
    this.baseCtx.save()
    this.baseCtx.globalCompositeOperation = 'destination-out'
    this.baseCtx.drawImage(this.selection, 0, 0)
    this.baseCtx.restore()
    this.clearSelection(false)
    this.commit()
  }

  private keepSelection(invert: boolean): void {
    if (!this.selection) {
      toast('请先用矩形、套索或魔棒创建选区', 'info')
      return
    }
    this.pushUndo()
    const mask = invert ? this.invertedSelection() : this.selection
    const temp = document.createElement('canvas')
    temp.width = this.base.width
    temp.height = this.base.height
    const tctx = temp.getContext('2d') as CanvasRenderingContext2D
    tctx.drawImage(this.base, 0, 0)
    tctx.globalCompositeOperation = 'destination-in'
    tctx.drawImage(mask, 0, 0)
    this.baseCtx.clearRect(0, 0, this.base.width, this.base.height)
    this.baseCtx.drawImage(temp, 0, 0)
    this.clearSelection(false)
    this.commit()
  }

  private invertedSelection(): HTMLCanvasElement {
    const inverse = document.createElement('canvas')
    inverse.width = this.base.width
    inverse.height = this.base.height
    const ctx = inverse.getContext('2d') as CanvasRenderingContext2D
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, inverse.width, inverse.height)
    ctx.globalCompositeOperation = 'destination-out'
    if (this.selection) ctx.drawImage(this.selection, 0, 0)
    return inverse
  }

  private cropSelection(): void {
    const bounds = this.selectionBounds()
    if (!bounds) {
      toast('请先创建选区', 'info')
      return
    }
    this.pushUndo()
    this.cropTo(bounds.x, bounds.y, bounds.width, bounds.height, false)
    this.clearSelection(false)
    this.commit()
  }

  trimToContent(): void {
    if (!this.imageLoaded) return
    const bounds = this.alphaBounds()
    if (!bounds) return
    if (
      bounds.width === this.base.width &&
      bounds.height === this.base.height &&
      bounds.x === 0 &&
      bounds.y === 0
    ) {
      return
    }
    this.pushUndo()
    this.cropTo(bounds.x, bounds.y, bounds.width, bounds.height, false)
    this.clearSelection(false)
    this.commit()
  }

  private cropTo(x: number, y: number, width: number, height: number, withUndo = true): void {
    const oldWidth = this.base.width
    const oldHeight = this.base.height
    const sx = Math.max(0, Math.min(oldWidth - 1, Math.round(x)))
    const sy = Math.max(0, Math.min(oldHeight - 1, Math.round(y)))
    const sw = Math.max(1, Math.min(oldWidth - sx, Math.round(width)))
    const sh = Math.max(1, Math.min(oldHeight - sy, Math.round(height)))
    if (withUndo) this.pushUndo()
    const temp = document.createElement('canvas')
    temp.width = sw
    temp.height = sh
    const tctx = temp.getContext('2d') as CanvasRenderingContext2D
    tctx.drawImage(this.base, sx, sy, sw, sh, 0, 0, sw, sh)
    if (this.source && this.source.width === oldWidth && this.source.height === oldHeight) {
      const croppedSource = document.createElement('canvas')
      croppedSource.width = sw
      croppedSource.height = sh
      croppedSource
        .getContext('2d')
        ?.drawImage(this.source, sx, sy, sw, sh, 0, 0, sw, sh)
      this.source = croppedSource
    }
    this.base.width = sw
    this.base.height = sh
    this.baseCtx.clearRect(0, 0, sw, sh)
    this.baseCtx.drawImage(temp, 0, 0)
    this.canvas.width = sw
    this.canvas.height = sh
    this.selection = null
    this.selectionOverlay = null
    this.selectionOverlayDirty = true
    this.selectionBoundsCache = undefined
    window.requestAnimationFrame(() => this.fitView())
  }

  getResult(maxSize = 1024): EditorResult | null {
    if (!this.imageLoaded) return null
    const bounds = this.alphaBounds()
    if (!bounds) return null
    const limit = Math.min(2048, Math.max(64, Math.round(maxSize)))
    const scale = Math.min(1, limit / Math.max(bounds.width, bounds.height))
    const width = Math.max(1, Math.round(bounds.width * scale))
    const height = Math.max(1, Math.round(bounds.height * scale))
    const output = document.createElement('canvas')
    output.width = width
    output.height = height
    const ctx = output.getContext('2d') as CanvasRenderingContext2D
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(
      this.base,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      0,
      0,
      width,
      height
    )
    return { dataUrl: output.toDataURL('image/png'), width, height }
  }

  getStats(): EditorStats | null {
    if (!this.imageLoaded) return null
    const width = this.base.width
    const height = this.base.height
    const image = this.baseCtx.getImageData(0, 0, width, height)
    let alphaPixels = 0
    let edgePixels = 0
    for (let i = 3; i < image.data.length; i += 4) {
      const alpha = image.data[i]
      if (alpha > ALPHA_THRESHOLD) {
        alphaPixels += 1
        if (alpha < 250) edgePixels += 1
      }
    }
    return {
      width,
      height,
      coverage: alphaPixels / Math.max(1, width * height),
      alphaPixels,
      edgePixels,
      bounds: alphaBounds(image.data, width, height)
    }
  }

  hasImage(): boolean {
    return this.imageLoaded
  }
}
