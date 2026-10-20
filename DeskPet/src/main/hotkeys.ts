import { globalShortcut } from 'electron'
import type { HotkeySettings, HotkeyStatus } from '../shared/types'
import { log } from './logger'

type HotkeyName = keyof HotkeySettings

export class HotkeyManager {
  private status: HotkeyStatus = { entries: [] }

  register(
    settings: HotkeySettings,
    handlers: Record<HotkeyName, () => void>
  ): HotkeyStatus {
    globalShortcut.unregisterAll()
    const entries: HotkeyStatus['entries'] = []
    for (const name of Object.keys(settings) as HotkeyName[]) {
      const accelerator = settings[name].trim()
      if (!accelerator) continue
      let ok = false
      try {
        ok = globalShortcut.register(accelerator, handlers[name])
      } catch (error) {
        log.warn(`Could not register hotkey ${accelerator}`, error)
      }
      if (!ok) log.warn(`Hotkey is already in use or invalid: ${accelerator}`)
      entries.push({ name, accelerator, ok })
    }
    this.status = { entries }
    return this.status
  }

  get(): HotkeyStatus {
    return this.status
  }

  dispose(): void {
    globalShortcut.unregisterAll()
    this.status = { entries: [] }
  }
}
