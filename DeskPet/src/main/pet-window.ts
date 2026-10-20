import { BrowserWindow, Menu, screen, shell } from 'electron'
import { CHAT_WINDOW, clamp, PET_WINDOW } from '../shared/defaults'
import type {
  CursorInfo,
  InputEvent,
  PetCommand,
  PetEnv,
  Rect,
  SettingsTab,
  TestActionPayload
} from '../shared/types'
import type { ConfigStore } from './config-store'
import { log } from './logger'
import { iconPath, preloadPath, rendererUrl } from './paths'

interface PetWindowCallbacks {
  openSettings: (tab?: SettingsTab) => void
  quit: () => void
  onVisibilityChanged?: (visible: boolean) => void
}

const CURSOR_POLL_MS = 40
const CURSOR_SEND_MS = 60
const POSITION_SAVE_MS = 1400

export class PetWindow {
  private win: BrowserWindow | null = null
  private hitbox: Rect | null = null
  private chatOpen = false
  private dragging = false
  private ignored: boolean | null = null
  private cursorTimer: NodeJS.Timeout | null = null
  private saveTimer: NodeJS.Timeout | null = null
  private lastInteractive = false
  private lastCursorSent = 0
  private lastInsideSent = false
  private isHidden = false

  constructor(
    private readonly config: ConfigStore,
    private readonly callbacks: PetWindowCallbacks
  ) {}

  get window(): BrowserWindow | null {
    return this.win
  }

  get isOpen(): boolean {
    return this.win !== null && !this.win.isDestroyed()
  }

  create(options: { hidden?: boolean } = {}): void {
    if (this.isOpen) return
    const cfg = this.config.get()
    const bounds = this.initialBounds(cfg.window.x, cfg.window.y)
    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: true,
      roundedCorners: false,
      title: 'DeskPet',
      icon: iconPath(),
      webPreferences: {
        preload: preloadPath(),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
        devTools: true
      }
    })
    this.win = win
    this.applyWindowFlags()
    win.setIgnoreMouseEvents(true, { forward: true })
    this.ignored = true

    const url = rendererUrl('pet')
    if (url.dev) void win.loadURL(url.dev)
    else void win.loadFile(url.file)

    let revealed = false
    const reveal = (reason: string): void => {
      if (revealed || win.isDestroyed()) return
      revealed = true
      if (options.hidden) {
        this.isHidden = true
        win.hide()
      } else {
        this.isHidden = false
        log.info(`Pet window shown (${reason})`, win.getBounds())
        win.showInactive()
        this.applyWindowFlags()
        this.startCursorLoop()
        this.sendCommand('wake')
      }
      this.callbacks.onVisibilityChanged?.(!options.hidden)
      this.sendEnvChanged()
    }

    win.once('ready-to-show', () => reveal('ready-to-show'))
    if (!options.hidden) {
      // ready-to-show can be delayed by a broken GPU/compositor; never leave
      // the user with an invisible transparent window.
      setTimeout(() => {
        if (!revealed) log.warn('ready-to-show timed out, showing the pet window anyway')
        reveal('fallback-timeout')
      }, 2200)
    }

    win.on('closed', () => {
      this.stopCursorLoop()
      this.win = null
      log.info('Pet window closed')
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
    win.webContents.on('render-process-gone', (_event, details) => {
      log.error('Pet renderer gone', details.reason)
    })
  }

  private initialBounds(savedX: number | null, savedY: number | null): Rect {
    const primary = screen.getPrimaryDisplay()
    const area = primary.workArea
    const width = Math.min(PET_WINDOW.width, area.width)
    const height = Math.min(PET_WINDOW.height, area.height)
    const fallbackX = area.x + area.width - width - 32
    const fallbackY = area.y + area.height - height
    let x = typeof savedX === 'number' ? savedX : fallbackX
    let y = typeof savedY === 'number' ? savedY : fallbackY
    const display = screen.getDisplayNearestPoint({
      x: Math.round(x + width / 2),
      y: Math.round(y + height / 2)
    })
    const wa = display.workArea
    x = clamp(x, wa.x - 20, wa.x + wa.width - width + 20)
    y = clamp(y, wa.y - 20, wa.y + wa.height - height + 20)
    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height)
    }
  }

  getEnv(): PetEnv {
    const win = this.win
    if (!win || win.isDestroyed()) {
      const area = screen.getPrimaryDisplay().workArea
      return {
        workArea: area,
        bounds: { x: area.x, y: area.y, width: PET_WINDOW.width, height: PET_WINDOW.height },
        windowSize: { width: PET_WINDOW.width, height: PET_WINDOW.height },
        scaleFactor: 1,
        chatOpen: this.chatOpen,
        visible: false
      }
    }
    const bounds = win.getBounds()
    const display = screen.getDisplayMatching(bounds)
    return {
      workArea: display.workArea,
      bounds,
      windowSize: { width: bounds.width, height: bounds.height },
      scaleFactor: display.scaleFactor,
      chatOpen: this.chatOpen,
      visible: win.isVisible()
    }
  }

  applyConfig(): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    this.applyWindowFlags()
    if (!this.config.get().pet.clickThrough) this.setIgnore(false)
  }

  private applyWindowFlags(): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    const cfg = this.config.get()
    win.setAlwaysOnTop(cfg.pet.alwaysOnTop)
    win.setVisibleOnAllWorkspaces(cfg.pet.showOnAllWorkspaces, { visibleOnFullScreen: true })
    if (cfg.pet.alwaysOnTop && win.isVisible()) {
      try {
        win.moveTop()
      } catch (error) {
        log.warn('Could not raise the pet window', error)
      }
    }
  }

  setHitbox(rect: Rect | null): void {
    if (!rect) {
      this.hitbox = null
      return
    }
    if (
      !Number.isFinite(rect.x) ||
      !Number.isFinite(rect.y) ||
      !Number.isFinite(rect.width) ||
      !Number.isFinite(rect.height)
    ) {
      return
    }
    this.hitbox = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height))
    }
  }

  moveTo(x: number, y: number): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    const bounds = win.getBounds()
    const display = screen.getDisplayNearestPoint({
      x: Math.round(x + bounds.width / 2),
      y: Math.round(y + bounds.height / 2)
    })
    const area = display.workArea
    const nextX = Math.round(clamp(x, area.x - 24, area.x + area.width - bounds.width + 24))
    const nextY = Math.round(clamp(y, area.y - 40, area.y + area.height - bounds.height + 24))
    if (nextX === bounds.x && nextY === bounds.y) return
    win.setPosition(nextX, nextY, false)
    this.scheduleSavePosition()
  }

  private scheduleSavePosition(): void {
    if (!this.config.get().savePosition) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.persistPosition()
    }, POSITION_SAVE_MS)
  }

  persistPosition(): void {
    if (!this.config.get().savePosition) return
    const win = this.win
    if (!win || win.isDestroyed()) return
    const bounds = win.getBounds()
    this.config.patch({ window: { x: bounds.x, y: bounds.y } })
  }

  beginDrag(): void {
    this.dragging = true
    this.setIgnore(false)
  }

  endDrag(): void {
    this.dragging = false
    this.scheduleSavePosition()
    const env = this.getEnv()
    this.send('pet:env', env)
  }

  setInteractive(interactive: boolean): void {
    if (!interactive) return
    this.lastInteractive = true
    this.setIgnore(false)
  }

  async setChatOpen(open: boolean): Promise<PetEnv> {
    const win = this.win
    if (!win || win.isDestroyed()) return this.getEnv()
    this.chatOpen = open
    if (open) {
      this.setIgnore(false)
      win.focus()
    }
    const old = win.getBounds()
    const display = screen.getDisplayMatching(old)
    const area = display.workArea
    const width = Math.max(300, Math.min(open ? CHAT_WINDOW.width : PET_WINDOW.width, area.width - 16))
    const height = Math.max(240, Math.min(open ? CHAT_WINDOW.height : PET_WINDOW.height, area.height - 16))
    const x = clamp(
      old.x + (old.width - width) / 2,
      area.x,
      Math.max(area.x, area.x + area.width - width)
    )
    const y = clamp(
      old.y + old.height - height,
      area.y,
      Math.max(area.y, area.y + area.height - height)
    )
    win.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height)
    })
    const env = this.getEnv()
    win.webContents.send('pet:env', env)
    this.scheduleSavePosition()
    return env
  }

  toggle(): boolean {
    if (!this.isOpen) {
      this.create()
      return true
    }
    const win = this.win
    if (!win) return false
    if (win.isVisible()) {
      win.hide()
      this.isHidden = true
      this.stopCursorLoop()
      this.callbacks.onVisibilityChanged?.(false)
      return false
    }
    win.showInactive()
    this.isHidden = false
    this.applyWindowFlags()
    this.startCursorLoop()
    this.sendCommand('wake')
    this.callbacks.onVisibilityChanged?.(true)
    this.sendEnvChanged()
    return true
  }

  hide(): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    win.hide()
    this.isHidden = true
    this.stopCursorLoop()
    this.callbacks.onVisibilityChanged?.(false)
  }

  show(): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    win.showInactive()
    this.isHidden = false
    this.applyWindowFlags()
    this.startCursorLoop()
    this.callbacks.onVisibilityChanged?.(true)
    this.sendEnvChanged()
    this.sendCommand('wake')
  }

  async resetPosition(): Promise<PetEnv> {
    const win = this.win
    if (!win || win.isDestroyed()) return this.getEnv()
    const bounds = this.initialBounds(null, null)
    win.setBounds(bounds)
    this.config.patch({ window: { x: bounds.x, y: bounds.y } })
    const env = this.getEnv()
    win.webContents.send('pet:env', env)
    return env
  }

  contextMenu(): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    const menu = Menu.buildFromTemplate([
      {
        label: '和我聊天',
        click: () => this.sendCommand('open-chat')
      },
      {
        label: '打个招呼',
        click: () => this.sendCommand('say-hello')
      },
      { type: 'separator' },
      {
        label: '设置…',
        click: () => this.callbacks.openSettings()
      },
      {
        label: '换个位置',
        click: () => {
          void this.resetPosition()
        }
      },
      {
        label: '隐藏桌宠',
        click: () => this.hide()
      },
      { type: 'separator' },
      {
        label: '退出 DeskPet',
        click: () => this.callbacks.quit()
      }
    ])
    menu.popup({ window: win })
  }

  sendCommand(command: PetCommand): void {
    this.send('pet:command', command)
  }

  sendInput(event: InputEvent): void {
    this.send('pet:input', event)
  }

  sendTestAction(payload: TestActionPayload): void {
    this.send('pet:test-action', payload)
  }

  sendConfigChanged(): void {
    this.send('config:changed', this.config.get())
  }

  sendEnvChanged(): void {
    const env = this.getEnv()
    this.send('pet:env', env)
  }

  private send(channel: string, payload?: unknown): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    win.webContents.send(channel, payload)
  }

  private startCursorLoop(): void {
    if (this.cursorTimer) return
    this.cursorTimer = setInterval(() => this.pollCursor(), CURSOR_POLL_MS)
  }

  private stopCursorLoop(): void {
    if (this.cursorTimer) {
      clearInterval(this.cursorTimer)
      this.cursorTimer = null
    }
  }

  private pollCursor(): void {
    const win = this.win
    if (!win || win.isDestroyed() || !win.isVisible()) return
    const bounds = win.getBounds()
    const cursor = screen.getCursorScreenPoint()
    const x = cursor.x - bounds.x
    const y = cursor.y - bounds.y
    const inside = this.pointInside(x, y)
    const interactive =
      this.dragging ||
      this.chatOpen ||
      !this.config.get().pet.clickThrough ||
      inside

    if (interactive !== this.lastInteractive) {
      this.lastInteractive = interactive
      this.setIgnore(!interactive)
    }

    const now = Date.now()
    if (now - this.lastCursorSent >= CURSOR_SEND_MS || inside !== this.lastInsideSent) {
      this.lastCursorSent = now
      this.lastInsideSent = inside
      const info: CursorInfo = {
        x,
        y,
        screenX: cursor.x,
        screenY: cursor.y,
        inside
      }
      win.webContents.send('pet:cursor', info)
    }
  }

  private pointInside(x: number, y: number): boolean {
    const win = this.win
    if (!win) return false
    const rect =
      this.hitbox ??
      {
        x: PET_WINDOW.width / 2 - 120,
        y: PET_WINDOW.height - 250,
        width: 240,
        height: 250
      }
    const padding = 4
    return (
      x >= rect.x - padding &&
      y >= rect.y - padding &&
      x <= rect.x + rect.width + padding &&
      y <= rect.y + rect.height + padding
    )
  }

  private setIgnore(ignore: boolean): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    if (this.ignored === ignore) return
    this.ignored = ignore
    try {
      win.setIgnoreMouseEvents(ignore, { forward: true })
    } catch (error) {
      log.warn('setIgnoreMouseEvents failed', error)
    }
  }

  close(): void {
    this.stopCursorLoop()
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }
}
