import type { ActionAssets, PetAction, PetPack } from '../../shared/types'
import { PET_ANIMATIONS, PET_TRIGGERS } from '../../shared/types'
import { h, confirmDialog, promptDialog, toast } from '../shared/dom'
import type { SettingsContext, TabView } from './state'
import { splitSpriteSheet, toDataUrl } from './spritesheet'
import { assetUrl } from './spritesheet'
import {
  badge,
  button,
  card,
  emptyState,
  hint,
  notifyError,
  section,
  select,
  slider,
  textarea,
  textInput
} from './ui'

interface FrameRef {
  src: string
  dataUrl?: string
}

interface SoundRef {
  src: string | null
  dataUrl?: string
  name?: string
  changed: boolean
}

interface ActionDraft {
  action: PetAction
  frames: FrameRef[]
  framesChanged: boolean
  sound: SoundRef
  isNew: boolean
}

function cloneAction(action: PetAction): PetAction {
  return JSON.parse(JSON.stringify(action)) as PetAction
}

export class ActionsTab implements TabView {
  readonly el = h('div', { class: 'tab-body' })
  private readonly petSelect: HTMLSelectElement
  private readonly listEl = h('div', { class: 'action-list' })
  private readonly editorEl = h('div', { class: 'action-editor' })
  private petId = ''
  private selectedId: string | null = null
  private draft: ActionDraft | null = null
  private readonly audio = new Audio()

  constructor(private readonly ctx: SettingsContext) {
    this.petSelect = select({
      value: '',
      options: [],
      onChange: (value) => {
        this.petId = value
        this.selectedId = null
        this.draft = null
        this.renderAll()
      }
    })

    this.el.append(
      card(
        h(
          'div',
          { class: 'section-head row-between' },
          h(
            'div',
            {},
            h('h3', { text: '动作与声音' }),
            h('p', {
              text: '给桌宠绑定键盘、鼠标、点击等反应，也可以导入序列帧或精灵图做出真正的动画。'
            })
          ),
          h('div', { class: 'action-row' }, this.petSelect)
        ),
        h(
          'div',
          { class: 'action-toolbar' },
          button('＋ 新增动作', () => this.newAction(), 'primary'),
          button('↺ 恢复默认动作', () => void this.resetActions(), 'ghost')
        ),
        h('div', { class: 'actions-layout' }, this.listEl, this.editorEl),
        hint('序列帧建议使用透明背景 PNG；动作音效支持 MP3 / WAV / OGG / M4A 等格式。')
      )
    )

    this.refresh()
  }

  onShow(): void {
    this.refresh()
  }

  refresh(): void {
    const packs = this.ctx.state.packs
    const previous = this.petId
    this.petSelect.replaceChildren()
    for (const pack of packs) {
      this.petSelect.append(h('option', { value: pack.id, text: pack.name }))
    }
    const preferred =
      packs.find((pack) => pack.id === previous) ??
      packs.find((pack) => pack.id === this.ctx.state.config.activePetId) ??
      packs[0]
    const nextPetId = preferred?.id ?? ''
    if (nextPetId !== this.petId) {
      this.draft = null
      this.selectedId = null
    }
    this.petId = nextPetId
    this.petSelect.value = this.petId
    if (this.draft && this.draft.action.id) {
      this.selectedId = this.draft.action.id
    }
    this.renderAll()
  }

  private currentPack(): PetPack | undefined {
    return this.ctx.state.packById(this.petId)
  }

  private renderAll(): void {
    this.renderList()
    this.renderEditor()
  }

  private renderList(): void {
    const pack = this.currentPack()
    this.listEl.replaceChildren()
    if (!pack) {
      this.listEl.append(emptyState('还没有桌宠'))
      return
    }
    if (pack.actions.length === 0) {
      this.listEl.append(emptyState('还没有动作，点击「新增动作」创建'))
      return
    }
    for (const action of pack.actions) {
      const active = action.id === this.selectedId
      const checkbox = h('input', {
        type: 'checkbox',
        checked: action.enabled,
        on: {
          change: () => {
            const target = this.ctx.state.packById(this.petId)?.actions.find(
              (item) => item.id === action.id
            )
            if (target) {
              target.enabled = checkbox.checked
              void this.ctx.api.pets
                .saveAction(this.petId, target, {})
                .then((updated) => {
                  this.ctx.state.packs = this.ctx.state.packs.map((item) =>
                    item.id === updated.id ? updated : item
                  )
                  this.renderList()
                })
                .catch(notifyError)
            }
          }
        }
      })
      const triggerLabel =
        PET_TRIGGERS.find((item) => item.value === action.trigger)?.label ?? action.trigger
      this.listEl.append(
        h(
          'div',
          {
            class: `action-item${active ? ' active' : ''}${action.enabled ? '' : ' disabled'}`,
            on: {
              click: () => {
                this.selectedId = action.id
                this.draft = this.createDraft(action)
                this.renderAll()
              }
            }
          },
          h('span', { class: 'switch small', on: { click: (event) => event.stopPropagation() } }, checkbox),
          h(
            'div',
            { class: 'action-item-info' },
            h('strong', { text: action.name }),
            h('span', {
              text: `${triggerLabel} · ${action.frames.length ? `${action.frames.length} 帧` : '无序列帧'}`
            })
          ),
          action.sound ? badge('🔊', 'muted') : null,
          badge(action.trigger === 'custom' ? '手动' : '自动', 'accent')
        )
      )
    }
  }

  private createDraft(action: PetAction): ActionDraft {
    return {
      action: cloneAction(action),
      frames: action.frames.map((path) => ({ src: assetUrl(this.petId, path) })),
      framesChanged: false,
      sound: {
        src: action.sound ? assetUrl(this.petId, action.sound) : null,
        changed: false
      },
      isNew: false
    }
  }

  private buildFrameSection(): HTMLElement {
    const draft = this.draft
    if (!draft) return h('div')
    const strip = h('div', { class: 'frame-strip' })
    draft.frames.forEach((frame, index) => {
      strip.append(
        h(
          'div',
          { class: 'frame-thumb' },
          h('img', { attrs: { src: frame.src, alt: `帧 ${index + 1}` } }),
          h('span', { class: 'frame-index', text: String(index + 1) }),
          h('button', {
            class: 'frame-remove',
            text: '×',
            title: '移除这一帧',
            on: {
              click: (event) => {
                event.stopPropagation()
                this.removeFrame(index)
              }
            }
          })
        )
      )
    })
    if (draft.frames.length === 0) {
      strip.append(h('span', { class: 'muted', text: '还没有序列帧，动作会使用整体的缩放 / 旋转动画。' }))
    }
    return h(
      'div',
      { class: 'sub-section' },
      h(
        'div',
        { class: 'sub-head' },
        h('strong', { text: '序列帧' }),
        h('span', {
          class: 'muted',
          text: draft.frames.length ? `${draft.frames.length} 帧` : '可选'
        })
      ),
      strip,
      h(
        'div',
        { class: 'action-row' },
        button('🖼 导入帧图片', () => void this.importFrames()),
        button('🧩 从精灵图切分', () => void this.splitSheet()),
        button('清空帧', () => {
          draft.frames = []
          draft.framesChanged = true
          this.renderEditor()
        }, 'ghost', { disabled: draft.frames.length === 0 })
      )
    )
  }

  private buildSoundSection(): HTMLElement {
    const draft = this.draft
    if (!draft) return h('div')
    const sound = draft.sound
    const rawName = sound.name ?? (sound.src ? (sound.src.split('/').pop() ?? '') : '')
    let name = rawName
    try {
      name = decodeURIComponent(rawName)
    } catch {
      /* keep the raw file name */
    }
    return h(
      'div',
      { class: 'sub-section' },
      h(
        'div',
        { class: 'sub-head' },
        h('strong', { text: '动作音效 / 语音' }),
        h('span', { class: 'muted', text: sound.src ? name || '已设置' : '未设置' })
      ),
      h(
        'div',
        { class: 'action-row' },
        button('🎵 选择音频', () => void this.chooseSound()),
        button('▶ 试听', () => this.playSoundPreview(), 'ghost', { disabled: !sound.src }),
        button('移除音效', () => {
          draft.sound = { src: null, changed: true }
          this.renderEditor()
        }, 'ghost', { disabled: !sound.src })
      )
    )
  }

  private newAction(): void {
    const id = `action-${Date.now().toString(36)}`
    const action: PetAction = {
      id,
      name: '新动作',
      trigger: 'custom',
      animation: 'bounce',
      durationMs: 900,
      frames: [],
      frameDurationMs: 120,
      sound: null,
      say: '',
      cooldownMs: 3000,
      enabled: true
    }
    this.draft = {
      action,
      frames: [],
      framesChanged: false,
      sound: { src: null, changed: false },
      isNew: true
    }
    this.selectedId = id
    this.renderAll()
  }

  private removeFrame(index: number): void {
    const draft = this.draft
    if (!draft) return
    draft.frames.splice(index, 1)
    draft.framesChanged = true
    this.renderEditor()
  }

  private async importFrames(): Promise<void> {
    const draft = this.draft
    if (!draft) return
    try {
      const images = await this.ctx.api.dialogs.openImages()
      if (images.length === 0) return
      for (const image of images) {
        draft.frames.push({ src: image.dataUrl, dataUrl: image.dataUrl })
      }
      draft.framesChanged = true
      this.renderEditor()
      toast(`已加入 ${images.length} 帧`, 'success')
    } catch (error) {
      notifyError(error)
    }
  }

  private async splitSheet(): Promise<void> {
    const draft = this.draft
    if (!draft) return
    try {
      const image = await this.ctx.api.dialogs.openImage()
      if (!image) return
      const rowsText = await promptDialog({
        title: '精灵图有几行？',
        message: '例如一张 3×4 的精灵图：行数 3、列数 4。空白的格子会自动跳过。',
        value: '1',
        confirmText: '下一步'
      })
      if (!rowsText) return
      const colsText = await promptDialog({
        title: '精灵图有几列？',
        value: '4',
        confirmText: '开始切分'
      })
      if (!colsText) return
      const rows = Number(rowsText)
      const cols = Number(colsText)
      if (!Number.isFinite(rows) || !Number.isFinite(cols) || rows < 1 || cols < 1) {
        toast('行列数必须是正整数', 'error')
        return
      }
      const frames = await splitSpriteSheet(image.dataUrl, rows, cols)
      if (frames.length === 0) {
        toast('没有切出有效帧，请检查行列数', 'error')
        return
      }
      for (const frame of frames) draft.frames.push({ src: frame, dataUrl: frame })
      draft.framesChanged = true
      this.renderEditor()
      toast(`切出了 ${frames.length} 帧`, 'success')
    } catch (error) {
      notifyError(error)
    }
  }

  private async chooseSound(): Promise<void> {
    const draft = this.draft
    if (!draft) return
    try {
      const audio = await this.ctx.api.dialogs.openAudio()
      if (!audio) return
      draft.sound = {
        src: audio.dataUrl,
        dataUrl: audio.dataUrl,
        name: audio.name,
        changed: true
      }
      this.renderEditor()
      this.playSoundPreview()
    } catch (error) {
      notifyError(error)
    }
  }

  private playSoundPreview(): void {
    const sound = this.draft?.sound
    if (!sound?.src) return
    try {
      this.audio.pause()
      this.audio.src = sound.src
      this.audio.volume = this.ctx.state.config.voice.volume * this.ctx.state.config.voice.sfxVolume
      void this.audio.play().catch(() => toast('这个格式可能无法播放', 'error'))
    } catch {
      toast('这个格式可能无法播放', 'error')
    }
  }

  private renderEditor(): void {
    this.editorEl.replaceChildren()
    const draft = this.draft
    if (!draft) {
      this.editorEl.append(
        h(
          'div',
          { class: 'editor-empty' },
          h('div', { class: 'editor-empty-icon', text: '🎬' }),
          h('p', { text: '从左边选择一个动作进行编辑，或新建一个动作。' }),
          h('p', {
            class: 'muted',
            text: '动作可以绑定触发条件、序列帧、音效和一句台词。'
          })
        )
      )
      return
    }
    const action = draft.action
    const nameInput = textInput({
      value: action.name,
      placeholder: '动作名称',
      onInput: (value) => {
        draft.action.name = value
      }
    })
    const triggerSelect = select({
      value: action.trigger,
      options: PET_TRIGGERS,
      onChange: (value) => {
        draft.action.trigger = value as PetAction['trigger']
        this.renderList()
      }
    })
    const animationSelect = select({
      value: action.animation,
      options: PET_ANIMATIONS,
      onChange: (value) => {
        draft.action.animation = value as PetAction['animation']
      }
    })
    const duration = slider({
      label: '动画时长',
      value: action.durationMs,
      min: 150,
      max: 6000,
      step: 50,
      format: (value) => `${(value / 1000).toFixed(2)} 秒`,
      onChange: (value) => {
        draft.action.durationMs = value
      }
    })
    const frameDuration = slider({
      label: '帧间隔',
      value: action.frameDurationMs,
      min: 40,
      max: 600,
      step: 10,
      format: (value) => `${Math.round(value)} ms`,
      onChange: (value) => {
        draft.action.frameDurationMs = value
      }
    })
    const cooldown = slider({
      label: '冷却时间',
      value: action.cooldownMs,
      min: 0,
      max: 300000,
      step: 500,
      format: (value) =>
        value >= 60000
          ? `${(value / 60000).toFixed(1)} 分钟`
          : `${Math.round(value / 1000)} 秒`,
      onChange: (value) => {
        draft.action.cooldownMs = value
      }
    })
    const sayInput = textarea({
      value: action.say,
      placeholder: '触发时要说的话（可留空）',
      rows: 2,
      onChange: (value) => {
        draft.action.say = value
      }
    })
    const emotionInput = textInput({
      value: action.emotion ?? '',
      placeholder: 'happy / sad / think / sleepy / love（可留空）',
      onChange: (value) => {
        draft.action.emotion = value.trim() || undefined
      }
    })
    const enabledCheckbox = h('input', {
      type: 'checkbox',
      checked: action.enabled,
      on: {
        change: () => {
          draft.action.enabled = enabledCheckbox.checked
          this.renderList()
        }
      }
    })

    const triggerButton = PET_TRIGGERS.find((item) => item.value === action.trigger)
    const header = h(
      'div',
      { class: 'action-editor-head' },
      h('div', {}, h('h4', { text: action.name || '未命名动作' }), h('span', {
        class: 'muted',
        text: triggerButton?.label ?? action.trigger
      })),
      h('div', { class: 'action-row' }, badge(draft.isNew ? '新动作' : '编辑中', 'accent'), h('label', { class: 'switch' }, enabledCheckbox))
    )

    const frameSection = this.buildFrameSection()
    const soundSection = this.buildSoundSection()

    this.editorEl.append(
      header,
      h(
        'div',
        { class: 'form-grid' },
        h('label', { class: 'field' }, h('span', { class: 'field-label', text: '动作名称' }), nameInput),
        h('label', { class: 'field' }, h('span', { class: 'field-label', text: '触发方式' }), triggerSelect),
        h('label', { class: 'field' }, h('span', { class: 'field-label', text: '动画效果' }), animationSelect),
        h('label', { class: 'field' }, h('span', { class: 'field-label', text: '情绪标记（AI 回复时可用）' }), emotionInput)
      ),
      duration.el,
      cooldown.el,
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: '气泡台词' }), sayInput),
      frameSection,
      frameDuration.el,
      soundSection,
      h(
        'div',
        { class: 'action-editor-footer' },
        button('💾 保存动作', () => void this.save(), 'primary'),
        button('▶ 在桌面上测试', () => this.test()),
        button('🗑 删除动作', () => void this.deleteAction(), 'danger', {
          disabled: draft.isNew
        }),
        button('取消', () => {
          this.draft = null
          this.selectedId = null
          this.renderAll()
        }, 'ghost')
      )
    )
  }

  private async save(): Promise<void> {
    const draft = this.draft
    const pack = this.currentPack()
    if (!draft || !pack) return
    if (!draft.action.name.trim()) {
      toast('动作需要一个名字', 'error')
      return
    }
    const assets: ActionAssets = {}
    try {
      if (draft.framesChanged) {
        const frames: string[] = []
        for (const frame of draft.frames) {
          frames.push(frame.dataUrl ?? (await toDataUrl(frame.src)))
        }
        assets.frames = frames
      }
      if (draft.sound.changed) {
        assets.sound = draft.sound.dataUrl
          ? { dataUrl: draft.sound.dataUrl, name: draft.sound.name ?? 'sound' }
          : null
      }
      const updated = await this.ctx.api.pets.saveAction(this.petId, draft.action, assets)
      this.ctx.state.packs = this.ctx.state.packs.map((item) =>
        item.id === updated.id ? updated : item
      )
      const savedAction = updated.actions.find((item) => item.id === draft.action.id)
      if (savedAction) {
        this.selectedId = savedAction.id
        const nextDraft = this.createDraft(savedAction)
        nextDraft.isNew = false
        this.draft = nextDraft
      }
      this.renderAll()
      toast('动作已保存', 'success')
    } catch (error) {
      notifyError(error)
    }
  }

  private test(): void {
    const draft = this.draft
    if (!draft) return
    const frames = draft.frames.map((frame) => frame.dataUrl ?? frame.src)
    const sound = draft.sound.dataUrl ?? draft.sound.src
    this.ctx.api.pet.testAction({
      action: { ...draft.action, frames: [], sound: null },
      frames,
      sound
    })
    toast('已在桌面上播放这个动作', 'info')
  }

  private async deleteAction(): Promise<void> {
    const draft = this.draft
    if (!draft || draft.isNew) return
    const ok = await confirmDialog({
      title: '删除动作',
      message: `确定删除「${draft.action.name}」吗？`,
      confirmText: '删除',
      danger: true
    })
    if (!ok) return
    try {
      const updated = await this.ctx.api.pets.deleteAction(this.petId, draft.action.id)
      this.ctx.state.packs = this.ctx.state.packs.map((item) =>
        item.id === updated.id ? updated : item
      )
      this.draft = null
      this.selectedId = null
      this.renderAll()
      toast('动作已删除', 'success')
    } catch (error) {
      notifyError(error)
    }
  }

  private async resetActions(): Promise<void> {
    const ok = await confirmDialog({
      title: '恢复默认动作',
      message: '会删除这个桌宠的所有动作、序列帧和动作音效，替换为内置的默认动作。确定继续吗？',
      confirmText: '恢复默认',
      danger: true
    })
    if (!ok) return
    try {
      const updated = await this.ctx.api.pets.resetActions(this.petId)
      this.ctx.state.packs = this.ctx.state.packs.map((item) =>
        item.id === updated.id ? updated : item
      )
      this.draft = null
      this.selectedId = null
      this.renderAll()
      toast('已恢复默认动作', 'success')
    } catch (error) {
      notifyError(error)
    }
  }
}
