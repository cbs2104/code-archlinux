import type { DeepPartial, PetPack, PetSettings } from '../../shared/types'
import { h, confirmDialog, promptDialog, toast } from '../shared/dom'
import type { SettingsContext, TabView } from './state'
import {
  badge,
  button,
  card,
  emptyState,
  hint,
  notifyError,
  petThumb,
  row,
  section,
  slider,
  toggle
} from './ui'

export class PetTab implements TabView {
  readonly el = h('div', { class: 'tab-body' })
  private pendingPet: Partial<PetSettings> = {}
  private pendingTimer = 0

  constructor(private readonly ctx: SettingsContext) {
    this.render()
  }

  onShow(): void {
    void this.refresh()
  }

  async refresh(): Promise<void> {
    await this.ctx.state.reloadPacks()
    this.render()
  }

  private queuePet(patch: Partial<PetSettings>): void {
    Object.assign(this.pendingPet, patch)
    if (this.pendingTimer) window.clearTimeout(this.pendingTimer)
    this.pendingTimer = window.setTimeout(() => {
      const pending = this.pendingPet
      this.pendingPet = {}
      this.pendingTimer = 0
      void this.ctx.state.patch({ pet: pending as DeepPartial<PetSettings> })
    }, 140)
  }

  private render(): void {
    const active = this.ctx.state.activePack
    this.el.replaceChildren(
      this.renderHero(active),
      this.renderList(),
      this.renderAppearance(active),
      this.renderPosition()
    )
  }

  private renderHero(active: PetPack | undefined): HTMLElement {
    if (!active) {
      return card(
        emptyState(
          '还没有桌宠，先去抠一张图片吧！',
          button('打开抠图工坊', () => this.ctx.openTab('studio'), 'primary')
        )
      )
    }
    const greeting = h('input', {
      class: 'input',
      value: active.greeting,
      placeholder: '见面时想说的话（可留空）',
      on: {
        change: () => {
          void this.ctx.state.api.pets
            .setGreeting(active.id, greeting.value)
            .then(() => {
              toast('见面台词已保存', 'success')
              return this.ctx.state.reloadPacks()
            })
            .catch(notifyError)
        }
      }
    })

    const actions = h(
      'div',
      { class: 'action-row' },
      button('✏️ 重命名', () => void this.rename(active)),
      button('📦 导出', () => void this.exportPack(active)),
      button('📄 复制', () => void this.duplicate(active), 'secondary', {
        disabled: active.kind === 'builtin',
        title: active.kind === 'builtin' ? '内置形象无法复制，请先用抠图工坊新建' : undefined
      }),
      button('🗑 删除', () => void this.remove(active), 'danger', {
        disabled: active.kind === 'builtin'
      })
    )

    return card(
      h(
        'div',
        { class: 'hero' },
        h('div', { class: 'hero-thumb' }, petThumb(active, 152)),
        h(
          'div',
          { class: 'hero-info' },
          h(
            'div',
            { class: 'hero-heading' },
            h('h3', { text: active.name }),
            badge(active.kind === 'builtin' ? '内置形象' : '自定义形象', 'accent')
          ),
          h('p', {
            class: 'muted',
            text: `作者 ${active.author || '未知'} · v${active.version} · ${active.actions.length} 个动作`
          }),
          h(
            'label',
            { class: 'field' },
            h('span', { class: 'field-label', text: '见面台词' }),
            greeting,
            h('span', {
              class: 'field-hint',
              text: '启动、切换桌宠或点击托盘「打招呼」时会说这句话'
            })
          ),
          actions
        )
      ),
      h(
        'div',
        { class: 'quick-links' },
        button('💬 和它聊天', () => this.ctx.api.pet.openChat()),
        button('🙈 隐藏桌宠', () => this.ctx.api.pet.hide(), 'ghost'),
        button('⚙ 换形象', () => this.ctx.openTab('studio'), 'ghost')
      )
    )
  }

  private renderList(): HTMLElement {
    const { state, api } = this.ctx
    const grid = h('div', { class: 'pet-grid' })
    for (const pack of state.packs) {
      const active = pack.id === state.config.activePetId
      grid.append(
        h(
          'button',
          {
            class: `pet-card${active ? ' active' : ''}`,
            title: active ? '正在使用' : `使用「${pack.name}」`,
            on: { click: () => void this.setActive(pack) }
          },
          petThumb(pack, 70),
          h(
            'div',
            { class: 'pet-card-info' },
            h('strong', { text: pack.name }),
            h('span', {
              text: pack.sprite.kind === 'builtin' ? '内置形象' : `自定义 · ${pack.actions.length} 动作`
            })
          ),
          active ? badge('使用中', 'ok') : null
        )
      )
    }

    return card(
      h(
        'div',
        { class: 'section-head row-between' },
        h(
          'div',
          {},
          h('h3', { text: '我的桌宠' }),
          h('p', { text: '可以同时保存多个形象，随时切换。' })
        ),
        h(
          'div',
          { class: 'action-row' },
          button('＋ 抠图新建', () => this.ctx.openTab('studio'), 'primary'),
          button('📥 导入桌宠包', () => void this.importPack()),
          button('📤 导出当前', () => {
            const active = state.activePack
            if (active) void this.exportPack(active)
          })
        )
      ),
      grid,
      state.packs.length === 0 ? emptyState('暂时没有桌宠') : null,
      hint('桌宠包是一个包含 pet.json、图片和音频的文件夹，可分享给朋友。')
    )
  }

  private renderAppearance(active: PetPack | undefined): HTMLElement {
    const cfg = this.ctx.state.config
    const scale = slider({
      label: '桌宠大小',
      value: cfg.pet.scale,
      min: 0.5,
      max: 1.4,
      step: 0.05,
      format: (value) => `${Math.round(value * 100)}%`,
      onChange: (value) => this.queuePet({ scale: value })
    })
    const opacity = slider({
      label: '不透明度',
      value: cfg.pet.opacity,
      min: 0.3,
      max: 1,
      step: 0.05,
      format: (value) => `${Math.round(value * 100)}%`,
      onChange: (value) => this.queuePet({ opacity: value })
    })
    const roamSpeed = slider({
      label: '溜达速度',
      value: cfg.pet.roamSpeed,
      min: 20,
      max: 160,
      step: 5,
      format: (value) => `${Math.round(value)} px/s`,
      onChange: (value) => this.queuePet({ roamSpeed: value })
    })
    return card(
      section(
        '外观与行为',
        active ? `正在使用「${active.name}」` : null,
        scale.el,
        opacity.el,
        toggle({
          label: '始终显示在最上层',
          checked: cfg.pet.alwaysOnTop,
          onChange: (value) => void this.ctx.state.patch({ pet: { alwaysOnTop: value } }),
          hint: '关闭后可被其他窗口覆盖，适合专注工作。'
        }),
        toggle({
          label: '显示在所有桌面 / 全屏应用之上',
          checked: cfg.pet.showOnAllWorkspaces,
          onChange: (value) => void this.ctx.state.patch({ pet: { showOnAllWorkspaces: value } }),
          hint: 'Linux 生效；关闭后切换工作区时桌宠会留在原来的桌面。'
        }),
        toggle({
          label: '透明区域可以点穿',
          checked: cfg.pet.clickThrough,
          onChange: (value) => void this.ctx.state.patch({ pet: { clickThrough: value } }),
          hint: '默认关闭。开启后只有桌宠本体和按钮拦截鼠标；如果开启后点击不灵敏，请关闭此项。'
        }),
        toggle({
          label: '自动在桌面上溜达',
          checked: cfg.pet.roaming,
          onChange: (value) => void this.ctx.state.patch({ pet: { roaming: value } })
        }),
        roamSpeed.el
      )
    )
  }

  private renderPosition(): HTMLElement {
    const cfg = this.ctx.state.config
    return card(
      section(
        '位置',
        null,
        row(
          '把它找回来',
          button('回到右下角', () => {
            void this.ctx.api.pet.resetPosition().then(() => toast('已经把它放回右下角', 'success'))
          })
        ),
        toggle({
          label: '记住上次的位置',
          checked: cfg.savePosition,
          onChange: (value) => void this.ctx.state.patch({ savePosition: value })
        }),
        hint('如果桌宠跑到屏幕外，也可以用托盘菜单里的「把它放回右下角」。')
      )
    )
  }

  private async setActive(pack: PetPack): Promise<void> {
    if (pack.id === this.ctx.state.config.activePetId) return
    await this.ctx.state.setActive(pack.id)
    toast(`现在由「${pack.name}」陪你`, 'success')
    this.render()
  }

  private async rename(pack: PetPack): Promise<void> {
    const name = await promptDialog({
      title: '给它改个名字',
      value: pack.name,
      placeholder: '比如：团子',
      confirmText: '改名'
    })
    if (!name) return
    try {
      await this.ctx.api.pets.rename(pack.id, name)
      await this.ctx.state.reloadPacks()
      toast('名字改好啦', 'success')
      this.render()
    } catch (error) {
      notifyError(error)
    }
  }

  private async exportPack(pack: PetPack): Promise<void> {
    try {
      const folder = await this.ctx.api.pets.exportPack(pack.id)
      if (folder) toast(`已导出到 ${folder}`, 'success', 6000)
    } catch (error) {
      notifyError(error)
    }
  }

  private async duplicate(pack: PetPack): Promise<void> {
    try {
      const copy = await this.ctx.api.pets.duplicate(pack.id)
      await this.ctx.state.reloadPacks()
      toast(`已复制为「${copy.name}」`, 'success')
      this.render()
    } catch (error) {
      notifyError(error)
    }
  }

  private async remove(pack: PetPack): Promise<void> {
    const ok = await confirmDialog({
      title: '删除桌宠',
      message: `确定要删除「${pack.name}」吗？它的动作、音频和图片都会一起删除，无法恢复。`,
      confirmText: '删除',
      danger: true
    })
    if (!ok) return
    try {
      await this.ctx.api.pets.remove(pack.id)
      await this.ctx.state.reloadPacks()
      toast('桌宠已删除', 'success')
      this.render()
    } catch (error) {
      notifyError(error)
    }
  }

  private async importPack(): Promise<void> {
    try {
      const pack = await this.ctx.api.pets.importPack()
      if (!pack) return
      await this.ctx.state.reloadPacks()
      toast(`已导入「${pack.name}」`, 'success')
      this.render()
    } catch (error) {
      notifyError(error)
    }
  }
}
