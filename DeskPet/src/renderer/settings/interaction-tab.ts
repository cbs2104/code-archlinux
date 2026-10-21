import type { DeepPartial, InteractionSettings, ReactionSettings } from '../../shared/types'
import { h, toast } from '../shared/dom'
import type { SettingsContext, TabView } from './state'
import {
  badge,
  button,
  card,
  hint,
  notifyError,
  row,
  section,
  slider,
  textInput,
  toggle
} from './ui'

const HOTKEY_LABELS: Record<string, string> = {
  togglePet: '显示 / 隐藏桌宠',
  openChat: '打开聊天窗口'
}

export class InteractionTab implements TabView {
  readonly el = h('div', { class: 'tab-body' })
  private togglePetInput: HTMLInputElement | null = null
  private openChatInput: HTMLInputElement | null = null
  private pending: Partial<ReactionSettings> = {}
  private timer = 0

  constructor(private readonly ctx: SettingsContext) {
    this.render()
  }

  onShow(): void {
    void this.ctx.state.refreshSystem().then(() => this.render())
  }

  private queueReaction(patch: Partial<ReactionSettings>): void {
    Object.assign(this.pending, patch)
    if (this.timer) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      const pending = this.pending
      this.pending = {}
      this.timer = 0
      void this.ctx.state.patch({
        interaction: { reactions: pending as DeepPartial<ReactionSettings> }
      })
    }, 140)
  }

  private render(): void {
    const { state } = this.ctx
    const cfg = state.config
    const status = state.inputStatus
    const platformNote = this.platformNote()
    const hotkeyStatus = state.hotkeyStatus.entries

    this.togglePetInput = textInput({
      value: cfg.hotkeys.togglePet,
      placeholder: 'Control+Alt+Shift+P',
      mono: true
    })
    this.openChatInput = textInput({
      value: cfg.hotkeys.openChat,
      placeholder: 'Control+Alt+Shift+K',
      mono: true
    })

    this.el.replaceChildren(
      card(
        section(
          '全局输入监听',
          '桌宠通过键盘、鼠标事件感知你正在做什么；只统计事件类型，不记录输入的字符。',
          h(
            'div',
            { class: 'status-line' },
            badge(status.running ? '监听中' : '未监听', status.running ? 'ok' : 'warn'),
            badge(`平台：${status.platform}`, 'muted'),
            status.sessionType !== 'native' ? badge(`会话：${status.sessionType}`, 'muted') : null
          ),
          toggle({
            label: '启用键盘 / 鼠标联动',
            checked: cfg.interaction.inputMonitor,
            onChange: (value) => {
              void this.ctx.state
                .patch({
                  interaction: { inputMonitor: value } as DeepPartial<InteractionSettings>
                })
                .then(() => new Promise((resolve) => window.setTimeout(resolve, 300)))
                .then(() => this.ctx.state.refreshSystem())
                .then(() => this.render())
            }
          }),
          status.error ? h('p', { class: 'status-error', text: status.error }) : null,
          platformNote,
          h(
            'div',
            { class: 'action-row' },
            button('重启监听', () => {
              void this.ctx.api.system
                .restartInput()
                .then((next) => {
                  state.inputStatus = next
                  this.render()
                  toast(next.running ? '监听已重启' : '监听仍未启动', next.running ? 'success' : 'error')
                })
                .catch(notifyError)
            })
          )
        )
      ),
      card(
        section(
          '对什么有反应',
          null,
          toggle({
            label: '眼睛跟着鼠标走',
            checked: cfg.interaction.reactions.lookAtCursor,
            onChange: (value) =>
              void this.ctx.state.patch({ interaction: { reactions: { lookAtCursor: value } } })
          }),
          toggle({
            label: '你打字时陪你',
            checked: cfg.interaction.reactions.typing,
            onChange: (value) => this.queueReaction({ typing: value })
          }),
          toggle({
            label: '你点击鼠标时看过来',
            checked: cfg.interaction.reactions.mouseClick,
            onChange: (value) => this.queueReaction({ mouseClick: value })
          }),
          toggle({
            label: '滚轮滚动时晃动',
            checked: cfg.interaction.reactions.wheel,
            onChange: (value) => this.queueReaction({ wheel: value })
          }),
          toggle({
            label: '快捷键 / 回车 / Esc 有反应',
            checked: cfg.interaction.reactions.hotkeys,
            onChange: (value) => this.queueReaction({ hotkeys: value })
          }),
          toggle({
            label: '鼠标靠近时打招呼',
            checked: cfg.interaction.reactions.mouseNear,
            onChange: (value) => this.queueReaction({ mouseNear: value })
          }),
          slider({
            label: '离开多久后睡觉',
            value: cfg.interaction.reactions.idleSleepMinutes,
            min: 0,
            max: 60,
            step: 1,
            format: (value) => (value <= 0 ? '从不睡觉' : `${value} 分钟`),
            onChange: (value) => this.queueReaction({ idleSleepMinutes: value })
          }).el,
          hint('这些反应会执行动作里对应触发条件的动作，可以在「动作与声音」里替换。')
        )
      ),
      card(
        section(
          '全局快捷键',
          '即使桌宠被其他窗口挡住，也能用快捷键叫它出来。',
          row('显示 / 隐藏桌宠', this.togglePetInput),
          row('打开聊天', this.openChatInput),
          h(
            'div',
            { class: 'action-row' },
            button('应用快捷键', () => void this.applyHotkeys(), 'primary'),
            button('显示桌宠', () => {
              void this.ctx.api.pet.toggle()
            }, 'ghost')
          ),
          h(
            'div',
            { class: 'hotkey-status' },
            ...hotkeyStatus.map((entry) =>
              h(
                'div',
                { class: 'hotkey-item' },
                h('span', { text: HOTKEY_LABELS[entry.name] ?? entry.name }),
                h('code', { text: entry.accelerator }),
                badge(entry.ok ? '已注册' : '注册失败', entry.ok ? 'ok' : 'warn')
              )
            ),
            hotkeyStatus.length === 0
              ? h('span', { class: 'muted', text: '还没有注册快捷键' })
              : null
          )
        )
      ),
      card(
        section(
          '开机启动',
          null,
          toggle({
            label: '开机时自动启动 DeskPet',
            checked: state.autostart,
            onChange: (value) => {
              void this.ctx.api.system.autostart
                .set(value)
                .then((result) => {
                  state.autostart = result
                  state.config = { ...state.config, launchAtLogin: result }
                  toast(result ? '已开启开机启动' : '已关闭开机启动', 'success')
                  this.render()
                })
                .catch(notifyError)
            }
          }),
          hint('写入 ~/.config/autostart/deskpet.desktop，登录后自动启动并显示桌宠。')
        )
      )
    )
  }

  private platformNote(): HTMLElement | null {
    const status = this.ctx.state.inputStatus
    if (status.sessionType === 'wayland') {
      return h('p', {
        class: 'status-warn',
        text: '当前是 Wayland 会话，DeskPet 通过 XWayland 运行；原生 Wayland 应用的键盘事件不会被捕获。'
      })
    }
    return h('p', {
      class: 'muted',
      text: 'Linux 需要 X11/XWayland 与 libXtst。若模块加载失败，请安装 libxtst 后重启 DeskPet。'
    })
  }

  private async applyHotkeys(): Promise<void> {
    const togglePet = this.togglePetInput?.value.trim() ?? ''
    const openChat = this.openChatInput?.value.trim() ?? ''
    await this.ctx.state.patch({ hotkeys: { togglePet, openChat } })
    await new Promise((resolve) => window.setTimeout(resolve, 150))
    await this.ctx.state.refreshSystem()
    this.render()
    const failed = this.ctx.state.hotkeyStatus.entries.filter((entry) => !entry.ok)
    if (failed.length > 0) {
      toast('有快捷键注册失败，可能被其他程序占用', 'error', 4200)
    } else {
      toast('快捷键已生效', 'success')
    }
  }
}
