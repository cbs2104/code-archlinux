import { h } from '../shared/dom'

export interface EditorResult {
  dataUrl: string
  width: number
  height: number
}

type Tool = 'rect' | 'lasso' | 'wand' | 'erase'

type Selection =
  | { type: 'rect'; x: number; y: number; width: number; height: number }
  | { type: 'lasso'; points: { x: number; y: number }[] }
  | null

interface Snapshot {
  data: ImageData
  width: number
  height: number
}

const MAX_DIM = 1400
const MAX_UNDO = 6
const ALPHA_THRESHOLD = 12

export class ImageEditor {
  readonly el: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly base: HTMLCanvasElement
  private readonly viewCtx: CanvasRenderingContext2D
  private readonly baseCtx: CanvasRenderingContext2D
  private readonly placeholder: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>()
  private readonly toleranceInput: HTMLInputElement
  private readonly brushInput: HTMLInputElement
  private readonly undoBtn: HTMLButtonElement
  private readonly redoBtn: HTMLButtonElement
  private tool: Tool = 'rect'
  private selection: Selection = null
  private drawing = false
  private startPoint: { x: number; y: number } | null = null
  private movePoint: { x: number; y: number } | null = null
  private lassoPoints: { x: number; y: number }[] = []
  private undoStack: Snapshot[] = []
  private redoStack: Snapshot[] = []
  private original: Snapshot | null = null
  private imageLoaded = false
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
    this.toleranceInput = h('input', {
      class: 'range',
      type: 'range',
      min: 0,
      max: 120,
      step: 1,
      value: '42'
    })
    this.brushInput = h('input', {
      class: 'range',
      type: 'range',
      min: 4,
      max: 80,
      step: 1,
      value: '24'
    })
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

    this.el = h(
      'div',
      { class: 'studio' },
      this.buildToolbar(),
      h(
        'div',
        { class: 'editor-stage' },
        this.canvas,
        this.placeholder,
        h('div', { class: 'editor-tip', text: '所有操作都按原图分辨率处理' })
      ),
      this.buildOperations(),
      h('div', { class: 'editor-footer' }, this.statusEl)
    )

    this.canvas.hidden = true
    this.bindCanvas()
    this.setTool('rect')
    this.syncButtons()
  }

  setOnChange(cb: () => void): void {
    this.onChange = cb
  }

  private buildToolbar(): HTMLElement {
    const toolGroup = h('div', { class: 'tool-group' })
    const tools: { id: Tool; label: string; hint: string }[] = [
      { id: 'rect', label: '▭ 矩形', hint: '框选一块区域' },
      { id: 'lasso', label: '✎ 套索', hint: '沿着目标边缘圈选' },
      { id: 'wand', label: '✨ 魔棒', hint: '点一下去掉相近颜色' },
      { id: 'erase', label: '⌫ 橡皮', hint: '手动擦除多余部分' }
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
    return h(
      'div',
      { class: 'editor-toolbar' },
      toolGroup,
      h('label', { class: 'inline-field' }, h('span', { text: '容差' }), this.toleranceInput),
      h('label', { class: 'inline-field' }, h('span', { text: '笔刷' }), this.brushInput),
      h('div', { class: 'toolbar-spacer' }),
      this.undoBtn,
      this.redoBtn
    )
  }

  private buildOperations(): HTMLElement {
    return h(
      'div',
      { class: 'editor-actions' },
      h('button', {
        class: 'btn btn-primary',
        text: '🪄 自动抠图',
        title: '从图片四周识别背景并去掉，只保留主体',
        on: { click: () => this.autoRemoveBackground() }
      }),
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
      }),
      h('button', {
        class: 'btn btn-ghost',
        text: '羽化边缘',
        on: { click: () => this.feather() }
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
  }

  private setTool(tool: Tool): void {
    this.tool = tool
    this.toolButtons.forEach((node, key) => node.classList.toggle('active', key === tool))
    this.canvas.style.cursor = 'crosshair'
    this.updateStatus()
  }

  private syncButtons(): void {
    this.undoBtn.disabled = this.undoStack.length === 0
    this.redoBtn.disabled = this.redoStack.length === 0
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

  private bindCanvas(): void {
    this.canvas.addEventListener('pointerdown', (event) => {
      if (!this.imageLoaded || event.button !== 0) return
      event.preventDefault()
      try {
        this.canvas.setPointerCapture(event.pointerId)
      } catch {
        /* ignore */
      }
      const point = this.toImagePoint(event)
      this.startPoint = point
      this.movePoint = point
      if (this.tool === 'wand') {
        this.pushUndo()
        this.removeBackground([point], Number(this.toleranceInput.value))
        this.selection = null
        this.commit()
        this.startPoint = null
        return
      }
      if (this.tool === 'erase') {
        this.pushUndo()
        this.drawing = true
        this.eraseCircle(point, Number(this.brushInput.value) / 2)
        this.commit()
        return
      }
      this.drawing = true
      this.selection = null
      if (this.tool === 'lasso') this.lassoPoints = [point]
      this.render()
    })

    this.canvas.addEventListener('pointermove', (event) => {
      if (!this.imageLoaded) return
      const point = this.toImagePoint(event)
      this.movePoint = point
      if (!this.drawing) return
      if (this.tool === 'erase') {
        this.eraseCircle(point, Number(this.brushInput.value) / 2)
        this.commit()
        return
      }
      if (this.tool === 'lasso') {
        const last = this.lassoPoints[this.lassoPoints.length - 1]
        if (!last || Math.hypot(last.x - point.x, last.y - point.y) > 2) this.lassoPoints.push(point)
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
        const x = Math.min(this.startPoint.x, this.movePoint.x)
        const y = Math.min(this.startPoint.y, this.movePoint.y)
        const width = Math.abs(this.movePoint.x - this.startPoint.x)
        const height = Math.abs(this.movePoint.y - this.startPoint.y)
        this.selection = width > 3 && height > 3 ? { type: 'rect', x, y, width, height } : null
      } else if (this.tool === 'lasso') {
        this.selection =
          this.lassoPoints.length > 3 ? { type: 'lasso', points: this.lassoPoints.slice() } : null
      }
      this.startPoint = null
      this.lassoPoints = []
      this.render()
      this.updateStatus()
      this.onChange?.()
    }
    this.canvas.addEventListener('pointerup', finish)
    this.canvas.addEventListener('pointercancel', finish)
    this.canvas.addEventListener('contextmenu', (event) => event.preventDefault())
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
    this.selection = null
    this.imageLoaded = true
    this.original = this.snapshot()
    this.render()
    this.updateStatus()
    this.syncButtons()
    this.onChange?.()
  }

  private snapshot(): Snapshot {
    return {
      data: this.baseCtx.getImageData(0, 0, this.base.width, this.base.height),
      width: this.base.width,
      height: this.base.height
    }
  }

  private restore(snapshot: Snapshot): void {
    this.base.width = snapshot.width
    this.base.height = snapshot.height
    this.canvas.width = snapshot.width
    this.canvas.height = snapshot.height
    this.baseCtx.putImageData(snapshot.data, 0, 0)
    this.selection = null
    this.render()
    this.updateStatus()
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
    this.restore(this.original)
    this.undoStack = []
    this.redoStack = []
    this.syncButtons()
    this.onChange?.()
  }

  private commit(): void {
    this.render()
    this.updateStatus()
    this.syncButtons()
    this.onChange?.()
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
    }
  }

  private updateStatus(): void {
    if (!this.imageLoaded) {
      this.statusEl.textContent = '等待图片…'
      return
    }
    const bounds = this.selectionBounds()
    const selectionInfo = bounds
      ? ` · 选区 ${Math.round(bounds.width)}×${Math.round(bounds.height)}`
      : ''
    this.statusEl.textContent = `输出参考 ${this.base.width}×${this.base.height}${selectionInfo} · 当前工具：${this.toolLabel()}`
  }

  private selectionPath(): Path2D | null {
    if (!this.selection) return null
    const path = new Path2D()
    if (this.selection.type === 'rect') {
      path.rect(this.selection.x, this.selection.y, this.selection.width, this.selection.height)
    } else {
      const points = this.selection.points
      if (points.length < 3) return null
      path.moveTo(points[0].x, points[0].y)
      for (let i = 1; i < points.length; i += 1) path.lineTo(points[i].x, points[i].y)
      path.closePath()
    }
    return path
  }

  private selectionBounds(): { x: number; y: number; width: number; height: number } | null {
    if (!this.selection) return null
    if (this.selection.type === 'rect') {
      return {
        x: this.selection.x,
        y: this.selection.y,
        width: this.selection.width,
        height: this.selection.height
      }
    }
    const points = this.selection.points
    if (points.length === 0) return null
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const point of points) {
      minX = Math.min(minX, point.x)
      minY = Math.min(minY, point.y)
      maxX = Math.max(maxX, point.x)
      maxY = Math.max(maxY, point.y)
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  }

  private render(): void {
    if (!this.imageLoaded) return
    const ctx = this.viewCtx
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.drawImage(this.base, 0, 0)

    let path = this.selectionPath()
    let rectBounds: { x: number; y: number; width: number; height: number } | null = null
    if (this.selection?.type === 'rect') rectBounds = this.selection
    if (!this.selection && this.drawing && this.tool === 'rect' && this.startPoint && this.movePoint) {
      const x = Math.min(this.startPoint.x, this.movePoint.x)
      const y = Math.min(this.startPoint.y, this.movePoint.y)
      const width = Math.abs(this.movePoint.x - this.startPoint.x)
      const height = Math.abs(this.movePoint.y - this.startPoint.y)
      path = new Path2D()
      path.rect(x, y, width, height)
      rectBounds = { x, y, width, height }
    }
    if (!this.selection && this.drawing && this.tool === 'lasso' && this.lassoPoints.length > 1) {
      path = new Path2D()
      path.moveTo(this.lassoPoints[0].x, this.lassoPoints[0].y)
      for (let i = 1; i < this.lassoPoints.length; i += 1) {
        path.lineTo(this.lassoPoints[i].x, this.lassoPoints[i].y)
      }
    }
    if (!path) return

    ctx.save()
    if (this.selection?.type === 'lasso' || (!this.selection && this.tool === 'lasso')) {
      const dim = new Path2D()
      dim.rect(0, 0, this.canvas.width, this.canvas.height)
      dim.addPath(path)
      ctx.fillStyle = 'rgba(8, 10, 18, 0.5)'
      ctx.fill(dim, 'evenodd')
    } else if (rectBounds) {
      const full = new Path2D()
      full.rect(0, 0, this.canvas.width, this.canvas.height)
      full.rect(rectBounds.x, rectBounds.y, rectBounds.width, rectBounds.height)
      ctx.fillStyle = 'rgba(8, 10, 18, 0.45)'
      ctx.fill(full, 'evenodd')
    }
    ctx.restore()

    ctx.save()
    ctx.lineWidth = Math.max(1, this.canvas.width / 900)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)'
    ctx.setLineDash([7, 5])
    ctx.stroke(path)
    ctx.restore()
  }

  hasImage(): boolean {
    return this.imageLoaded
  }

  private eraseCircle(point: { x: number; y: number }, radius: number): void {
    const ctx = this.baseCtx
    ctx.save()
    ctx.globalCompositeOperation = 'destination-out'
    ctx.beginPath()
    ctx.arc(point.x, point.y, Math.max(1, radius), 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  private removeBackground(
    seeds: { x: number; y: number }[],
    tolerance: number
  ): void {
    const width = this.base.width
    const height = this.base.height
    const image = this.baseCtx.getImageData(0, 0, width, height)
    const data = image.data
    const visited = new Uint8Array(width * height)
    const limit = Math.max(0, tolerance)
    for (const seed of seeds) {
      const start = seed.y * width + seed.x
      if (start < 0 || start >= width * height || visited[start]) continue
      const startOffset = start * 4
      if (data[startOffset + 3] === 0) {
        visited[start] = 1
        continue
      }
      const sr = data[startOffset]
      const sg = data[startOffset + 1]
      const sb = data[startOffset + 2]
      const stack: number[] = [start]
      while (stack.length > 0) {
        const index = stack.pop() as number
        if (visited[index]) continue
        const offset = index * 4
        if (data[offset + 3] === 0) {
          visited[index] = 1
          continue
        }
        const diff =
          (Math.abs(data[offset] - sr) +
            Math.abs(data[offset + 1] - sg) +
            Math.abs(data[offset + 2] - sb)) /
          3
        if (diff > limit) continue
        visited[index] = 1
        data[offset + 3] = 0
        const x = index % width
        const y = (index / width) | 0
        if (x > 0) stack.push(index - 1)
        if (x < width - 1) stack.push(index + 1)
        if (y > 0) stack.push(index - width)
        if (y < height - 1) stack.push(index + width)
      }
    }
    this.baseCtx.putImageData(image, 0, 0)
  }

  private keepLargestComponent(): void {
    const width = this.base.width
    const height = this.base.height
    const image = this.baseCtx.getImageData(0, 0, width, height)
    const data = image.data
    const labels = new Uint32Array(width * height)
    const sizes: number[] = [0]
    let nextLabel = 1
    const stack: number[] = []
    for (let i = 0; i < labels.length; i += 1) {
      if (labels[i] !== 0 || data[i * 4 + 3] <= ALPHA_THRESHOLD) continue
      const label = nextLabel
      nextLabel += 1
      sizes.push(0)
      labels[i] = label
      stack.push(i)
      while (stack.length > 0) {
        const index = stack.pop() as number
        sizes[label] += 1
        const x = index % width
        const y = (index / width) | 0
        const neighbours = [
          x > 0 ? index - 1 : -1,
          x < width - 1 ? index + 1 : -1,
          y > 0 ? index - width : -1,
          y < height - 1 ? index + width : -1
        ]
        for (const next of neighbours) {
          if (next < 0 || labels[next] !== 0) continue
          if (data[next * 4 + 3] <= ALPHA_THRESHOLD) continue
          labels[next] = label
          stack.push(next)
        }
      }
    }
    let largest = 0
    for (let label = 1; label < sizes.length; label += 1) {
      if (sizes[label] > (sizes[largest] ?? 0)) largest = label
    }
    if (largest === 0) return
    for (let i = 0; i < labels.length; i += 1) {
      if (labels[i] !== 0 && labels[i] !== largest) data[i * 4 + 3] = 0
    }
    this.baseCtx.putImageData(image, 0, 0)
  }

  autoRemoveBackground(): void {
    if (!this.imageLoaded) return
    this.pushUndo()
    const width = this.base.width
    const height = this.base.height
    const seeds: { x: number; y: number }[] = []
    const step = Math.max(2, Math.round(Math.min(width, height) / 180))
    for (let x = 0; x < width; x += step) {
      seeds.push({ x, y: 0 })
      seeds.push({ x, y: height - 1 })
    }
    for (let y = 0; y < height; y += step) {
      seeds.push({ x: 0, y })
      seeds.push({ x: width - 1, y })
    }
    seeds.push(
      { x: 0, y: 0 },
      { x: width - 1, y: 0 },
      { x: 0, y: height - 1 },
      { x: width - 1, y: height - 1 }
    )
    this.removeBackground(seeds, Number(this.toleranceInput.value))
    this.keepLargestComponent()
    const bounds = this.alphaBounds()
    if (bounds) this.cropTo(bounds.x, bounds.y, bounds.width, bounds.height, false)
    this.selection = null
    this.commit()
  }

  private deleteSelection(): void {
    const path = this.selectionPath()
    if (!path) return
    this.pushUndo()
    const ctx = this.baseCtx
    ctx.save()
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fill(path)
    ctx.restore()
    this.selection = null
    this.commit()
  }

  private keepSelection(invert: boolean): void {
    const path = this.selectionPath()
    if (!path) return
    this.pushUndo()
    const temp = document.createElement('canvas')
    temp.width = this.base.width
    temp.height = this.base.height
    const tctx = temp.getContext('2d') as CanvasRenderingContext2D
    tctx.drawImage(this.base, 0, 0)
    tctx.globalCompositeOperation = 'destination-in'
    tctx.fillStyle = '#fff'
    if (invert) {
      const mask = new Path2D()
      mask.rect(0, 0, temp.width, temp.height)
      mask.addPath(path)
      tctx.fill(mask, 'evenodd')
    } else {
      tctx.fill(path)
    }
    this.baseCtx.clearRect(0, 0, this.base.width, this.base.height)
    this.baseCtx.drawImage(temp, 0, 0)
    this.selection = null
    this.commit()
  }

  private cropSelection(): void {
    const bounds = this.selectionBounds()
    if (!bounds) return
    this.pushUndo()
    this.cropTo(bounds.x, bounds.y, bounds.width, bounds.height, false)
    this.selection = null
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
    this.selection = null
    this.commit()
  }

  private cropTo(x: number, y: number, width: number, height: number, withUndo = true): void {
    const sx = Math.max(0, Math.min(this.base.width - 1, Math.round(x)))
    const sy = Math.max(0, Math.min(this.base.height - 1, Math.round(y)))
    const sw = Math.max(1, Math.min(this.base.width - sx, Math.round(width)))
    const sh = Math.max(1, Math.min(this.base.height - sy, Math.round(height)))
    if (withUndo) this.pushUndo()
    const temp = document.createElement('canvas')
    temp.width = sw
    temp.height = sh
    const tctx = temp.getContext('2d') as CanvasRenderingContext2D
    tctx.drawImage(this.base, sx, sy, sw, sh, 0, 0, sw, sh)
    this.base.width = sw
    this.base.height = sh
    this.baseCtx.clearRect(0, 0, sw, sh)
    this.baseCtx.drawImage(temp, 0, 0)
    this.canvas.width = sw
    this.canvas.height = sh
  }

  private alphaBounds(): { x: number; y: number; width: number; height: number } | null {
    const width = this.base.width
    const height = this.base.height
    const data = this.baseCtx.getImageData(0, 0, width, height).data
    let minX = width
    let minY = height
    let maxX = -1
    let maxY = -1
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (data[(y * width + x) * 4 + 3] > ALPHA_THRESHOLD) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    if (maxX < minX || maxY < minY) return null
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
  }

  private feather(): void {
    if (!this.imageLoaded) return
    this.pushUndo()
    const width = this.base.width
    const height = this.base.height
    const image = this.baseCtx.getImageData(0, 0, width, height)
    const data = image.data
    const alpha = new Uint8ClampedArray(width * height)
    for (let i = 0; i < alpha.length; i += 1) alpha[i] = data[i * 4 + 3]
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0
        let count = 0
        for (let oy = -1; oy <= 1; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            const nx = x + ox
            const ny = y + oy
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
            sum += alpha[ny * width + nx]
            count += 1
          }
        }
        data[(y * width + x) * 4 + 3] = sum / count
      }
    }
    this.baseCtx.putImageData(image, 0, 0)
    this.commit()
  }

  getResult(maxSize = 1024): EditorResult | null {
    if (!this.imageLoaded) return null
    const bounds = this.alphaBounds()
    if (!bounds) return null
    const scale = Math.min(1, maxSize / Math.max(bounds.width, bounds.height))
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
}
