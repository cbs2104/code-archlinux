import { h, confirmDialog, toast } from '../shared/dom'
import type { SettingsContext, TabView } from './state'
import { button, card, hint, notifyError, row, section } from './ui'

const GITHUB_URL = 'https://github.com/DeskPet/DeskPet'

export class AboutTab implements TabView {
  readonly el = h('div', { class: 'tab-body' })

  constructor(private readonly ctx: SettingsContext) {
    this.render()
  }

  onShow(): void {
    this.render()
  }

  private render(): void {
    const info = this.ctx.state.info
    const shortcut = (keys: string, label: string): HTMLElement =>
      h('div', { class: 'shortcut-row' }, h('code', { text: keys }), h('span', { text: label }))

    this.el.replaceChildren(
      card(
        section(
          `DeskPet ${info.appVersion}`,
          '一个跨平台的桌面小搭档：抠出你喜欢的角色，让它对键盘鼠标做出反应，还能接入 AI 聊天。',
          h(
            'div',
            { class: 'info-grid' },
            h('span', { text: 'Electron' }),
            h('code', { text: info.electron }),
            h('span', { text: 'Chromium' }),
            h('code', { text: info.chrome }),
            h('span', { text: 'Node.js' }),
            h('code', { text: info.node }),
            h('span', { text: '系统' }),
            h('code', { text: `${info.platform} / ${info.arch}` }),
            h('span', { text: '打包模式' }),
            h('code', { text: info.packaged ? '已打包' : '开发模式' })
          ),
          h(
            'div',
            { class: 'action-row' },
            button('项目主页', () => {
              void this.ctx.api.app.openExternal(GITHUB_URL)
            }, 'primary'),
            button('打开数据目录', () => {
              void this.ctx.api.app.openPath(info.userData)
            }),
            button('查看日志', () => {
              void this.ctx.api.app.openPath(info.logFile).catch(() => {
                void this.ctx.api.app.showItemInFolder(info.logFile)
              })
            }, 'ghost')
          )
        )
      ),
      card(
        section(
          '数据与文件',
          '所有配置、桌宠包和聊天记录都在本机，不会上传到任何地方（除非你主动调用 AI） 。',
          row('配置目录', h('code', { class: 'path', text: info.userData })),
          row('桌宠包目录', h('code', { class: 'path', text: info.petsDir })),
          row('配置文件', h('code', { class: 'path', text: info.configFile })),
          row('日志文件', h('code', { class: 'path', text: info.logFile })),
          h(
            'div',
            { class: 'action-row' },
            button('打开桌宠目录', () => {
              void this.ctx.api.app.openPath(info.petsDir)
            }),
            button('定位配置文件', () => {
              void this.ctx.api.app.showItemInFolder(info.configFile)
            }, 'ghost')
          )
        )
      ),
      card(
        section(
          '快捷键与小技巧',
          null,
          shortcut(
            '双击桌宠',
            '触发双击动作；右键可以打开菜单（聊天、设置、隐藏、退出）'
          ),
          shortcut('拖动桌宠', '可以把它拎起来、扔到屏幕任意位置，松手后会落地'),
          shortcut('Esc', '收起聊天窗口'),
          shortcut('Ctrl + S', '桌宠会以为你保存了文件（可在动作里改）'),
          shortcut('Enter', '桌宠会点头（可在动作里改）'),
          hint('托盘图标里也可以显示/隐藏、打招呼、重置位置和开关机自启。')
        )
      ),
      card(
        section(
          '构建',
          'DeskPet 目前只面向 Linux，提供 electron-builder 配置和 GitHub Actions 自动打包。',
          h(
            'div',
            { class: 'code-block' },
            h('code', { text: 'npm install' }),
            h('code', { text: 'npm run dev' }),
            h('code', { text: 'npm run dist:linux' })
          ),
          hint('Linux 打包目标：AppImage / deb / rpm / pacman。')
        )
      ),
      card(
        section(
          '危险操作',
          null,
          h(
            'div',
            { class: 'action-row' },
            button('重置所有设置', () => void this.resetConfig(), 'danger'),
            button('退出 DeskPet', () => this.ctx.api.app.quit(), 'ghost')
          ),
          hint('重置设置不会删除桌宠包、动作和聊天记录。')
        )
      )
    )
  }

  private async resetConfig(): Promise<void> {
    const ok = await confirmDialog({
      title: '重置所有设置',
      message: '外观、互动、语音、AI 和快捷键设置都会恢复默认。桌宠包和动作不会被删除。',
      confirmText: '重置',
      danger: true
    })
    if (!ok) return
    try {
      this.ctx.state.config = await this.ctx.api.config.reset()
      await this.ctx.state.reloadPacks()
      await this.ctx.state.refreshSystem()
      this.render()
      toast('设置已恢复默认', 'success')
    } catch (error) {
      notifyError(error)
    }
  }
}
