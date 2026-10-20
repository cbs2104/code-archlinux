import { powerMonitor, systemPreferences } from 'electron'
import { createRequire } from 'node:module'
import type { AppConfig, InputEvent, InputStatus } from '../shared/types'
import { log } from './logger'

interface NativeHook {
  on(event: string, listener: (event: Record<string, unknown>) => void): void
  start(): void
  stop(): void
}

interface HookModule {
  uIOhook: NativeHook
  UiohookKey: Record<string, number>
}

interface KeyboardShape {
  keycode: number
  ctrlKey?: boolean
  altKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
}

const IDLE_POLL_MS = 10_000
const TYPING_THROTTLE_MS = 450
const POINTER_THROTTLE_MS = 400

export class InputMonitor {
  private hook: HookModule | null = null
  private loadError: string | null = null
  private running = false
  private listenersAttached = false
  private idleTimer: NodeJS.Timeout | null = null
  private sleeping = false
  private typingCount = 0
  private lastTypingAt = 0
  private lastClickAt = 0
  private lastWheelAt = 0
  private lastInputAt = Date.now()
  private nonTypingKeys = new Set<number>()

  constructor(
    private readonly getConfig: () => AppConfig,
    private readonly onEvent: (event: InputEvent) => void
  ) {}

  status(): InputStatus {
    let sessionType = process.platform === 'linux' ? 'x11' : 'native'
    if (process.platform === 'linux') {
      if (process.env.XDG_SESSION_TYPE) sessionType = process.env.XDG_SESSION_TYPE
      else if (process.env.WAYLAND_DISPLAY) sessionType = 'wayland'
    }
    let accessibilityTrusted = true
    if (process.platform === 'darwin') {
      try {
        accessibilityTrusted = systemPreferences.isTrustedAccessibilityClient(false)
      } catch {
        accessibilityTrusted = false
      }
    }
    return {
      available: this.hook !== null,
      running: this.running,
      error: this.loadError,
      platform: process.platform,
      sessionType,
      accessibilityTrusted
    }
  }

  start(): InputStatus {
    this.startIdleWatch()
    if (this.running) return this.status()

    if (!this.loadModule()) return this.status()

    if (process.platform === 'linux' && !process.env.DISPLAY) {
      this.loadError =
        '没有找到 X11 显示（DISPLAY）。Wayland 会话下只能部分监听，可在 Xorg 会话中使用完整键盘联动。'
      log.warn(this.loadError)
      return this.status()
    }

    try {
      if (!this.listenersAttached) this.attachListeners()
      this.hook?.uIOhook.start()
      this.running = true
      this.loadError = null
      log.info('Global input monitor started')
    } catch (error) {
      this.loadError = `全局输入监听启动失败：${(error as Error).message}`
      log.warn(this.loadError, error)
      this.running = false
    }
    return this.status()
  }

  stop(): void {
    try {
      if (this.running) this.hook?.uIOhook.stop()
    } catch (error) {
      log.warn('Failed to stop the input hook', error)
    }
    this.running = false
    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
  }

  restart(): InputStatus {
    this.stop()
    return this.start()
  }

  wake(): void {
    this.sleeping = false
    this.lastInputAt = Date.now()
  }

  promptAccessibility(): boolean {
    if (process.platform !== 'darwin') return true
    try {
      return systemPreferences.isTrustedAccessibilityClient(true)
    } catch {
      return false
    }
  }

  private loadModule(): boolean {
    if (this.hook) return true
    try {
      const requireFn = createRequire(__filename)
      const mod = requireFn('uiohook-napi') as HookModule
      if (!mod || !mod.uIOhook || !mod.UiohookKey) throw new Error('模块结构不正确')
      this.hook = mod
      this.buildNonTypingSet()
      this.loadError = null
      return true
    } catch (error) {
      this.loadError = `无法加载全局输入模块（uiohook-napi）：${(error as Error).message}`
      log.warn(this.loadError)
      return false
    }
  }

  private buildNonTypingSet(): void {
    if (!this.hook) return
    const names = [
      'Tab',
      'CapsLock',
      'Escape',
      'Enter',
      'PageUp',
      'PageDown',
      'End',
      'Home',
      'ArrowLeft',
      'ArrowUp',
      'ArrowRight',
      'ArrowDown',
      'Insert',
      'Delete',
      'Ctrl',
      'CtrlRight',
      'Alt',
      'AltRight',
      'Shift',
      'ShiftRight',
      'Meta',
      'MetaRight',
      'NumLock',
      'ScrollLock',
      'PrintScreen'
    ]
    for (const name of names) {
      const code = this.hook.UiohookKey[name]
      if (typeof code === 'number') this.nonTypingKeys.add(code)
    }
    for (let i = 1; i <= 24; i += 1) {
      const code = this.hook.UiohookKey[`F${i}`]
      if (typeof code === 'number') this.nonTypingKeys.add(code)
    }
  }

  private attachListeners(): void {
    if (!this.hook || this.listenersAttached) return
    this.hook.uIOhook.on('keydown', (event) => {
      this.handleKey(event as unknown as KeyboardShape)
    })
    this.hook.uIOhook.on('click', () => {
      this.handleClick()
    })
    this.hook.uIOhook.on('wheel', () => {
      this.handleWheel()
    })
    this.listenersAttached = true
  }

  private handleKey(event: KeyboardShape): void {
    const hook = this.hook
    if (!hook) return
    const now = Date.now()
    this.lastInputAt = now
    if (this.sleeping) {
      this.sleeping = false
      this.emit({ kind: 'wake' })
    }
    const reactions = this.getConfig().interaction.reactions
    const key = hook.UiohookKey
    const keycode = event.keycode

    if ((event.ctrlKey || event.metaKey) && keycode === key.S) {
      if (reactions.hotkeys) this.emit({ kind: 'save' })
      return
    }
    if (keycode === key.Enter) {
      if (reactions.hotkeys) this.emit({ kind: 'enter' })
      return
    }
    if (keycode === key.Escape) {
      if (reactions.hotkeys) this.emit({ kind: 'escape' })
      return
    }
    if (!reactions.typing) return
    if (event.ctrlKey || event.altKey || event.metaKey) return
    if (this.nonTypingKeys.has(keycode)) return

    this.typingCount += 1
    if (now - this.lastTypingAt >= TYPING_THROTTLE_MS) {
      const count = this.typingCount
      this.typingCount = 0
      this.lastTypingAt = now
      this.emit({ kind: 'typing', count })
    }
  }

  private handleClick(): void {
    const now = Date.now()
    this.lastInputAt = now
    if (!this.getConfig().interaction.reactions.mouseClick) return
    if (now - this.lastClickAt < POINTER_THROTTLE_MS) return
    this.lastClickAt = now
    this.emit({ kind: 'click' })
  }

  private handleWheel(): void {
    const now = Date.now()
    this.lastInputAt = now
    if (!this.getConfig().interaction.reactions.wheel) return
    if (now - this.lastWheelAt < POINTER_THROTTLE_MS) return
    this.lastWheelAt = now
    this.emit({ kind: 'wheel' })
  }

  private startIdleWatch(): void {
    if (this.idleTimer) return
    this.idleTimer = setInterval(() => this.checkIdle(), IDLE_POLL_MS)
  }

  private checkIdle(): void {
    const minutes = this.getConfig().interaction.reactions.idleSleepMinutes
    if (minutes <= 0) return
    let idleSeconds = 0
    try {
      idleSeconds = powerMonitor.getSystemIdleTime()
    } catch {
      idleSeconds = Math.floor((Date.now() - this.lastInputAt) / 1000)
    }
    if (!this.sleeping && idleSeconds >= minutes * 60) {
      this.sleeping = true
      this.emit({ kind: 'idle', detail: String(minutes) })
    } else if (this.sleeping && idleSeconds < 5) {
      this.sleeping = false
      this.emit({ kind: 'wake' })
    }
  }

  private emit(event: Omit<InputEvent, 'at'>): void {
    try {
      this.onEvent({ ...event, at: Date.now() } as InputEvent)
    } catch (error) {
      log.warn('Input listener threw', error)
    }
  }
}
