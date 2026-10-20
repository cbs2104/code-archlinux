import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { clone, clamp, CONFIG_VERSION, DEFAULT_CONFIG, mergeDeep } from '../shared/defaults'
import type { AppConfig, DeepPartial } from '../shared/types'
import { configFile } from './paths'
import { log } from './logger'

type StoredConfig = AppConfig & { apiKeyEnc?: string }

function num(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return clamp(parsed, min, max)
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function str(value: unknown, fallback: string, maxLength = 500): string {
  if (typeof value !== 'string') return fallback
  return value.slice(0, maxLength)
}

export class ConfigStore {
  private config: AppConfig = clone(DEFAULT_CONFIG)
  private readonly file = configFile()
  private saveTimer: NodeJS.Timeout | null = null
  private preservedEnc: string | null = null
  private firstRun = false

  get isFirstRun(): boolean {
    return this.firstRun
  }

  load(): AppConfig {
    const exists = existsSync(this.file)
    this.firstRun = !exists
    try {
      if (exists) {
        const stored = JSON.parse(readFileSync(this.file, 'utf8')) as StoredConfig
        const merged = mergeDeep(clone(DEFAULT_CONFIG), stored)
        const storedVersion = typeof stored.version === 'number' ? stored.version : 1
        if (storedVersion < 2) {
          // v1 never applied showOnAllWorkspaces on Linux, so its false value
          // usually just means "default". Make the pet follow all workspaces.
          merged.pet.showOnAllWorkspaces = true
          merged.version = CONFIG_VERSION
        }
        if (storedVersion < 3) {
          // Click-through depended on a 40ms global cursor poll and was the
          // default in early builds. Default to a fully clickable pet instead.
          merged.pet.clickThrough = false
          merged.version = CONFIG_VERSION
        }
        if (stored.apiKeyEnc) {
          try {
            if (safeStorage.isEncryptionAvailable()) {
              merged.ai.apiKey = safeStorage.decryptString(Buffer.from(stored.apiKeyEnc, 'base64'))
            } else {
              this.preservedEnc = stored.apiKeyEnc
            }
          } catch (error) {
            this.preservedEnc = stored.apiKeyEnc
            log.warn('Could not decrypt the API key, it will need to be entered again.', error)
          }
        }
        this.config = this.normalize(merged)
      }
    } catch (error) {
      log.warn('config.json could not be read, falling back to defaults.', error)
      this.config = clone(DEFAULT_CONFIG)
    }
    this.saveNow()
    return this.config
  }

  get(): AppConfig {
    return this.config
  }

  patch(patch: DeepPartial<AppConfig>): AppConfig {
    this.config = this.normalize(mergeDeep(this.config, patch))
    this.scheduleSave()
    return this.config
  }

  reset(): AppConfig {
    this.config = this.normalize(clone(DEFAULT_CONFIG))
    this.saveNow()
    return this.config
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.saveNow()
  }

  private normalize(input: AppConfig): AppConfig {
    const cfg = mergeDeep(clone(DEFAULT_CONFIG), input)
    cfg.version = CONFIG_VERSION
    cfg.activePetId = str(cfg.activePetId, 'builtin', 120) || 'builtin'
    cfg.savePosition = bool(cfg.savePosition, true)

    cfg.pet.scale = num(cfg.pet.scale, 0.5, 1.4, 1)
    cfg.pet.opacity = num(cfg.pet.opacity, 0.3, 1, 1)
    cfg.pet.alwaysOnTop = bool(cfg.pet.alwaysOnTop, true)
    cfg.pet.showOnAllWorkspaces = bool(cfg.pet.showOnAllWorkspaces, true)
    cfg.pet.roaming = bool(cfg.pet.roaming, true)
    cfg.pet.roamSpeed = num(cfg.pet.roamSpeed, 20, 160, 55)
    cfg.pet.clickThrough = bool(cfg.pet.clickThrough, false)

    cfg.window.x =
      typeof cfg.window.x === 'number' && Number.isFinite(cfg.window.x) ? cfg.window.x : null
    cfg.window.y =
      typeof cfg.window.y === 'number' && Number.isFinite(cfg.window.y) ? cfg.window.y : null

    cfg.interaction.inputMonitor = bool(cfg.interaction.inputMonitor, true)
    const reactions = cfg.interaction.reactions
    reactions.lookAtCursor = bool(reactions.lookAtCursor, true)
    reactions.typing = bool(reactions.typing, true)
    reactions.mouseClick = bool(reactions.mouseClick, true)
    reactions.wheel = bool(reactions.wheel, true)
    reactions.hotkeys = bool(reactions.hotkeys, true)
    reactions.mouseNear = bool(reactions.mouseNear, true)
    reactions.idleSleepMinutes = num(reactions.idleSleepMinutes, 0, 120, 5)

    cfg.voice.enabled = bool(cfg.voice.enabled, true)
    cfg.voice.voiceUri = str(cfg.voice.voiceUri, '', 300)
    cfg.voice.language = str(cfg.voice.language, 'zh-CN', 30)
    cfg.voice.rate = num(cfg.voice.rate, 0.5, 2, 1)
    cfg.voice.pitch = num(cfg.voice.pitch, 0.5, 2, 1.05)
    cfg.voice.volume = num(cfg.voice.volume, 0, 1, 0.9)
    cfg.voice.speakReplies = bool(cfg.voice.speakReplies, true)
    cfg.voice.speakActionLines = bool(cfg.voice.speakActionLines, true)
    cfg.voice.sfxVolume = num(cfg.voice.sfxVolume, 0, 1, 0.8)

    cfg.ai.enabled = bool(cfg.ai.enabled, false)
    cfg.ai.baseUrl = str(cfg.ai.baseUrl, DEFAULT_CONFIG.ai.baseUrl, 300)
      .trim()
      .replace(/\/+$/, '')
    cfg.ai.apiKey = str(cfg.ai.apiKey, '', 500).trim()
    cfg.ai.model = str(cfg.ai.model, DEFAULT_CONFIG.ai.model, 120).trim()
    cfg.ai.temperature = num(cfg.ai.temperature, 0, 2, 0.8)
    cfg.ai.maxTokens = Math.round(num(cfg.ai.maxTokens, 32, 4096, 400))
    cfg.ai.systemPrompt = str(cfg.ai.systemPrompt, DEFAULT_CONFIG.ai.systemPrompt, 6000)
    cfg.ai.streaming = bool(cfg.ai.streaming, true)
    cfg.ai.sttEnabled = bool(cfg.ai.sttEnabled, false)
    cfg.ai.sttModel = str(cfg.ai.sttModel, 'whisper-1', 120)
    cfg.ai.historyLimit = Math.round(num(cfg.ai.historyLimit, 2, 50, 12))

    cfg.hotkeys.togglePet = str(cfg.hotkeys.togglePet, DEFAULT_CONFIG.hotkeys.togglePet, 80)
    cfg.hotkeys.openChat = str(cfg.hotkeys.openChat, DEFAULT_CONFIG.hotkeys.openChat, 80)
    cfg.launchAtLogin = bool(cfg.launchAtLogin, false)

    return cfg
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.saveNow()
    }, 250)
  }

  private saveNow(): void {
    const stored = clone(this.config) as StoredConfig
    const apiKey = this.config.ai.apiKey
    stored.ai.apiKey = ''
    delete stored.apiKeyEnc
    if (apiKey) {
      this.preservedEnc = null
      try {
        if (safeStorage.isEncryptionAvailable()) {
          stored.apiKeyEnc = safeStorage.encryptString(apiKey).toString('base64')
        } else {
          stored.ai.apiKey = apiKey
        }
      } catch {
        stored.ai.apiKey = apiKey
      }
    } else if (this.preservedEnc) {
      stored.apiKeyEnc = this.preservedEnc
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      log.error('Failed to write config.json', error)
    }
  }
}
