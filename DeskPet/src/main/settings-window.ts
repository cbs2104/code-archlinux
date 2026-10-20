import { BrowserWindow, shell } from 'electron'
import type { SettingsTab } from '../shared/types'
import { iconPath, preloadPath, rendererUrl } from './paths'
import { log } from './logger'

export class SettingsWindow {
  private win: BrowserWindow | null = null
  private pendingTab: SettingsTab | null = null

  open(tab?: SettingsTab): void {
    if (tab) this.pendingTab = tab
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isMinimized()) this.win.restore()
      this.win.show()
      this.win.focus()
      if (this.pendingTab) {
        this.win.webContents.send('settings:tab', this.pendingTab)
        this.pendingTab = null
      }
      return
    }

    const win = new BrowserWindow({
      width: 1080,
      height: 780,
      minWidth: 900,
      minHeight: 620,
      show: false,
      title: 'DeskPet 设置',
      backgroundColor: '#0d1117',
      autoHideMenuBar: true,
      icon: iconPath(),
      webPreferences: {
        preload: preloadPath(),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false
      }
    })
    this.win = win

    const url = rendererUrl('settings')
    if (url.dev) void win.loadURL(url.dev)
    else void win.loadFile(url.file)

    let revealed = false
    const reveal = (reason: string): void => {
      if (revealed || win.isDestroyed()) return
      revealed = true
      log.info(`Settings window shown (${reason})`, win.getBounds())
      win.show()
      win.focus()
      if (this.pendingTab) {
        win.webContents.send('settings:tab', this.pendingTab)
        this.pendingTab = null
      }
    }

    win.once('ready-to-show', () => reveal('ready-to-show'))
    // Do not depend on a possibly broken GPU compositor to map the window.
    setTimeout(() => {
      if (!revealed) log.warn('Settings ready-to-show timed out, showing anyway')
      reveal('fallback-timeout')
    }, 2500)

    win.on('closed', () => {
      this.win = null
      log.info('Settings window closed')
    })

    win.webContents.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:\/\//i.test(target)) void shell.openExternal(target)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (event, target) => {
      if (target !== win.webContents.getURL()) {
        event.preventDefault()
        if (/^https?:\/\//i.test(target)) void shell.openExternal(target)
      }
    })
  }

  broadcast(channel: string, payload: unknown): void {
    if (!this.win || this.win.isDestroyed()) return
    this.win.webContents.send(channel, payload)
  }

  focus(): void {
    if (!this.win || this.win.isDestroyed()) return
    this.win.show()
    this.win.focus()
  }

  isOpen(): boolean {
    return this.win !== null && !this.win.isDestroyed()
  }

  close(): void {
    if (this.win && !this.win.isDestroyed()) this.win.close()
    this.win = null
  }
}
