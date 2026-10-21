import { h, toast } from '../shared/dom'
import type { ImageEditor } from './image-editor'
import { ImageEditor as Editor } from './image-editor'
import type { SettingsContext, TabView } from './state'
import { button, card, hint, notifyError, section, textInput } from './ui'

export class StudioTab implements TabView {
  readonly el = h('div', { class: 'tab-body' })
  private readonly editor: ImageEditor
  private readonly nameInput: HTMLInputElement
  private readonly targetSelect: HTMLSelectElement
  private readonly replaceBtn: HTMLButtonElement
  private readonly createBtn: HTMLButtonElement
  private readonly previewEl: HTMLElement
  private readonly infoEl: HTMLElement
  private readonly dropZone: HTMLElement
  private readonly sizeSelect: HTMLSelectElement
  private sourceName = ''
  private previewTimer = 0

  constructor(private readonly ctx: SettingsContext) {
    this.editor = new Editor()
    this.nameInput = textInput({
      value: '',
      placeholder: '给新桌宠起个名字，例如：团子'
    })
    this.targetSelect = h('select', { class: 'input select' })
    this.replaceBtn = button('替换所选桌宠', () => void this.saveReplace(), 'secondary', {
      disabled: true
    })
    this.createBtn = button('创建新桌宠', () => void this.saveNew(), 'primary', {
      disabled: true
    })
    this.previewEl = h('div', { class: 'studio-preview' })
    this.infoEl = h('span', { class: 'muted', text: '还没有抠好的图片' })
    this.dropZone = h('div', { class: 'editor-drop-hint', text: '也可以直接把图片拖到这里' })
    this.sizeSelect = h(
      'select',
      { class: 'input select' },
      h('option', { value: '512', text: '512 px · 轻量' }),
      h('option', { value: '768', text: '768 px · 推荐' }),
      h('option', { value: '1024', text: '1024 px · 高清' }),
      h('option', { value: '1536', text: '1536 px · 超清' })
    )
    this.sizeSelect.value = '1024'
    this.sizeSelect.addEventListener('change', () => this.syncResult())
    this.targetSelect.addEventListener('change', () => this.syncResult())

    this.editor.setOnChange(() => {
      if (this.previewTimer) window.clearTimeout(this.previewTimer)
      this.previewTimer = window.setTimeout(() => {
        this.previewTimer = 0
        this.syncResult()
      }, 90)
    })

    this.el.append(
      card(
        section(
          '抠图工坊 2.0',
          '从任意图片精细抠出桌宠：智能识别背景、软边精修、组合选区，并实时检查透明边缘。',
          h(
            'div',
            { class: 'action-row' },
            button('🖼 选择图片', () => void this.pickImage(), 'primary'),
            hint('支持 PNG / JPG / WebP；超大图片会先缩到 1600px 以便流畅编辑。')
          ),
          h(
            'ol',
            { class: 'steps' },
            h('li', {
              text: '智能抠图：自动分析四周背景，处理渐变/噪点并生成柔和透明边。'
            }),
            h('li', {
              text: '精细修补：用恢复画笔找回误删部分，用软边橡皮清掉残渣；Ctrl + 滚轮放大检查边缘。'
            }),
            h('li', {
              text: '组合选区：矩形/套索/魔棒支持新建、Shift 加选、Alt 减选，再做保留、删除或裁剪。'
            }),
            h('li', {
              text: '边缘精修：调整收缩/扩张、平滑、羽化与去色边，消除白边和锯齿。'
            })
          )
        ),
        this.editor.el,
        this.dropZone
      ),
      card(
        section(
          '保存为桌宠',
          '保存时会自动裁掉透明边并生成 PNG；输出尺寸可在右侧选择。',
          h(
            'div',
            { class: 'save-grid' },
            h(
              'div',
              { class: 'save-block' },
              h('span', { class: 'field-label', text: '新桌宠名字' }),
              this.nameInput,
              this.createBtn
            ),
            h(
              'div',
              { class: 'save-block' },
              h('span', { class: 'field-label', text: '替换已有桌宠的形象' }),
              this.targetSelect,
              this.replaceBtn
            ),
            h(
              'div',
              { class: 'save-block preview-block' },
              h('span', { class: 'field-label', text: '抠图结果预览' }),
              this.previewEl,
              this.infoEl,
              h('span', { class: 'field-label', text: '输出尺寸' }),
              this.sizeSelect,
              h('span', { class: 'field-hint', text: '按最长边等比缩放；透明边会被裁掉。' })
            )
          )
        ),
        hint('内置桌宠的形象是程序里画的，不能替换；请创建新桌宠。替换形象会保留原来的动作和语音。')
      )
    )

    this.bindDrop()
    this.refresh()
  }

  onShow(): void {
    this.refresh()
  }

  refresh(): void {
    const custom = this.ctx.state.packs.filter((pack) => pack.kind !== 'builtin')
    const previous = this.targetSelect.value
    this.targetSelect.replaceChildren()
    for (const pack of custom) {
      this.targetSelect.append(h('option', { value: pack.id, text: pack.name }))
    }
    if (custom.length === 0) {
      this.targetSelect.append(h('option', { value: '', text: '还没有自定义桌宠' }))
      this.targetSelect.disabled = true
    } else {
      this.targetSelect.disabled = false
      const preferred = custom.find((pack) => pack.id === this.ctx.state.config.activePetId)
      this.targetSelect.value = custom.some((pack) => pack.id === previous)
        ? previous
        : (preferred ?? custom[0]).id
    }
    this.syncResult()
  }

  private bindDrop(): void {
    const zone = this.editor.el
    const activate = (event: DragEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      this.dropZone.classList.add('active')
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    zone.addEventListener('dragover', activate)
    zone.addEventListener('dragenter', activate)
    zone.addEventListener('dragleave', () => this.dropZone.classList.remove('active'))
    zone.addEventListener('drop', (event) => {
      event.preventDefault()
      this.dropZone.classList.remove('active')
      const file = event.dataTransfer?.files?.[0]
      if (!file || !file.type.startsWith('image/')) {
        toast('请拖入一张图片', 'error')
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        this.sourceName = file.name
        if (!this.nameInput.value.trim()) {
          this.nameInput.value = file.name.replace(/\.[^.]+$/, '').slice(0, 20)
        }
        void this.loadImage(String(reader.result))
      }
      reader.readAsDataURL(file)
    })
  }

  private async pickImage(): Promise<void> {
    try {
      const image = await this.ctx.api.dialogs.openImage()
      if (!image) return
      this.sourceName = image.name
      if (!this.nameInput.value.trim()) {
        this.nameInput.value = image.name.replace(/\.[^.]+$/, '').slice(0, 20)
      }
      await this.loadImage(image.dataUrl)
    } catch (error) {
      notifyError(error)
    }
  }

  private async loadImage(dataUrl: string): Promise<void> {
    try {
      await this.editor.load(dataUrl)
      this.syncResult()
      toast('图片已载入，试试「智能抠图」', 'info')
    } catch (error) {
      notifyError(error)
    }
  }

  private syncResult(): void {
    const hasImage = this.editor.hasImage()
    this.createBtn.disabled = !hasImage
    this.replaceBtn.disabled = !hasImage || this.targetSelect.value === ''
    if (!hasImage) return
    const maxSize = Number(this.sizeSelect.value)
    const result = this.editor.getResult(maxSize)
    if (!result) {
      this.previewEl.replaceChildren()
      this.infoEl.textContent = '没有检测到不透明像素'
      return
    }
    const stats = this.editor.getStats()
    this.previewEl.replaceChildren(
      h('img', {
        attrs: { src: result.dataUrl, alt: '抠图预览' },
        style: { maxWidth: '160px', maxHeight: '160px' }
      })
    )
    this.infoEl.textContent = stats
      ? `将输出 ${result.width} × ${result.height} PNG · 柔边 ${stats.edgePixels.toLocaleString()} px`
      : `将输出 ${result.width} × ${result.height} PNG`
  }

  private async saveNew(): Promise<void> {
    const result = this.editor.getResult(Number(this.sizeSelect.value))
    if (!result) {
      toast('请先抠出至少一个像素的图案', 'error')
      return
    }
    const name = this.nameInput.value.trim() || '我的桌宠'
    try {
      const pack = await this.ctx.api.pets.createFromSprite({
        name,
        dataUrl: result.dataUrl,
        width: result.width,
        height: result.height,
        sourceName: this.sourceName
      })
      await this.ctx.state.reloadPacks()
      toast(`「${pack.name}」已经出现在桌面上了！`, 'success', 4000)
      this.ctx.openTab('pet')
    } catch (error) {
      notifyError(error)
    }
  }

  private async saveReplace(): Promise<void> {
    const petId = this.targetSelect.value
    if (!petId) {
      toast('请选择一个自定义桌宠', 'error')
      return
    }
    const result = this.editor.getResult(Number(this.sizeSelect.value))
    if (!result) {
      toast('请先抠出至少一个像素的图案', 'error')
      return
    }
    try {
      const pack = await this.ctx.api.pets.replaceSprite(petId, {
        dataUrl: result.dataUrl,
        width: result.width,
        height: result.height,
        sourceName: this.sourceName
      })
      await this.ctx.state.reloadPacks()
      toast(`已更新「${pack.name}」的形象`, 'success')
      this.ctx.openTab('pet')
    } catch (error) {
      notifyError(error)
    }
  }
}
