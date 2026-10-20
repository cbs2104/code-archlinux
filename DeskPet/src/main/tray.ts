import { Menu, Tray, nativeImage } from 'electron'
import { iconPath } from './paths'
import { log } from './logger'

export interface TrayActions {
  togglePet: () => void
  showPet: () => void
  openChat: () => void
  greet: () => void
  openSettings: () => void
  resetPosition: () => void
  openDataDir: () => void
  quit: () => void
  isPetVisible: () => boolean
  getAutostart: () => boolean
  setAutostart: (enabled: boolean) => boolean
}

export class TrayMenu {
  private tray: Tray | null = null
  private actions: TrayActions | null = null

  create(actions: TrayActions): void {
    this.actions = actions
    const size = 20
    let image = nativeImage.createFromPath(iconPath())
    if (image.isEmpty()) {
      log.warn(`Tray icon not found at ${iconPath()}`)
    } else {
      image = image.resize({ width: size, height: size })
    }
    try {
      this.tray = new Tray(image)
    } catch (error) {
      log.warn('Could not create the tray icon', error)
      return
    }
    this.tray.setToolTip('DeskPet')
    this.refresh()
    this.tray.on('double-click', () => actions.showPet())
  }

  refresh(): void {
    if (!this.tray || !this.actions) return
    const actions = this.actions
    const visible = actions.isPetVisible()
    const menu = Menu.buildFromTemplate([
      {
        label: visible ? '隐藏桌宠' : '显示桌宠',
        click: () => actions.togglePet()
      },
      { label: '和桌宠聊天', click: () => actions.openChat() },
      { label: '让它打个招呼', click: () => actions.greet() },
      { type: 'separator' },
      { label: '设置…', click: () => actions.openSettings() },
      { label: '把它放回右下角', click: () => actions.resetPosition() },
      {
        label: '开机自动启动',
        type: 'checkbox',
        checked: actions.getAutostart(),
        click: (item) => {
          const result = actions.setAutostart(item.checked)
          item.checked = result
        }
      },
      { type: 'separator' },
      { label: '打开 DeskPet 数据目录', click: () => actions.openDataDir() },
      { label: '退出 DeskPet', click: () => actions.quit() }
    ])
    this.tray.setContextMenu(menu)
  }

  dispose(): void {
    if (this.tray) {
      this.tray.destroy()
      this.tray = null
    }
  }
}
