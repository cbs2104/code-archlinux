import type {
  AppConfig,
  AppInfo,
  DeepPartial,
  DeskPetApi,
  HotkeyStatus,
  InputStatus,
  PetPack,
  SettingsTab
} from '../../shared/types'
import { notifyError } from './ui'

export interface SettingsContext {
  api: DeskPetApi
  state: SettingsState
  openTab: (tab: SettingsTab) => void
  rerender: () => void
  notify: (message: string, kind?: 'info' | 'success' | 'error') => void
}

export interface TabView {
  el: HTMLElement
  onShow?: () => void
  refresh?: () => void
}

export class SettingsState {
  config!: AppConfig
  packs: PetPack[] = []
  info!: AppInfo
  inputStatus!: InputStatus
  hotkeyStatus: HotkeyStatus = { entries: [] }
  autostart = false
  lastLocalPatch = 0

  constructor(readonly api: DeskPetApi) {}

  async load(): Promise<void> {
    const [config, packs, info, inputStatus, hotkeyStatus, autostart] = await Promise.all([
      this.api.config.get(),
      this.api.pets.list(),
      this.api.app.info(),
      this.api.system.inputStatus(),
      this.api.system.hotkeyStatus(),
      this.api.system.autostart.get()
    ])
    this.config = config
    this.packs = packs
    this.info = info
    this.inputStatus = inputStatus
    this.hotkeyStatus = hotkeyStatus
    this.autostart = autostart
  }

  get activePack(): PetPack | undefined {
    return this.packs.find((pack) => pack.id === this.config.activePetId) ?? this.packs[0]
  }

  packById(id: string): PetPack | undefined {
    return this.packs.find((pack) => pack.id === id)
  }

  async patch(patch: DeepPartial<AppConfig>): Promise<AppConfig> {
    this.lastLocalPatch = Date.now()
    try {
      this.config = await this.api.config.patch(patch)
    } catch (error) {
      notifyError(error)
    }
    return this.config
  }

  async reloadPacks(): Promise<PetPack[]> {
    try {
      this.packs = await this.api.pets.list()
      this.config = await this.api.config.get()
    } catch (error) {
      notifyError(error)
    }
    return this.packs
  }

  async setActive(petId: string): Promise<void> {
    try {
      await this.api.pets.setActive(petId)
      await this.reloadPacks()
    } catch (error) {
      notifyError(error)
    }
  }

  async refreshSystem(): Promise<void> {
    try {
      this.inputStatus = await this.api.system.inputStatus()
      this.hotkeyStatus = await this.api.system.hotkeyStatus()
      this.autostart = await this.api.system.autostart.get()
    } catch {
      /* status is best-effort */
    }
  }
}
