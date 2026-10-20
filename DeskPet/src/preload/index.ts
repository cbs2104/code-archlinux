import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ActionAssets,
  AiChatRequest,
  AppConfig,
  ChatHistoryEntry,
  DeepPartial,
  DeskPetApi,
  PetAction,
  PetPack,
  Rect,
  SettingsTab,
  SpriteInput,
  TestActionPayload
} from '../shared/types'

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: DeskPetApi = {
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    platform: process.platform,
    quit: () => {
      void ipcRenderer.invoke('app:quit')
    },
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
    showItemInFolder: (path) => ipcRenderer.invoke('app:show-item', path),
    openPath: (path) => ipcRenderer.invoke('app:open-path', path),
    relaunch: () => {
      void ipcRenderer.invoke('app:relaunch')
    }
  },
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    patch: (patch: DeepPartial<AppConfig>) => ipcRenderer.invoke('config:patch', patch),
    reset: () => ipcRenderer.invoke('config:reset'),
    onChange: (cb) => on('config:changed', cb)
  },
  pets: {
    list: () => ipcRenderer.invoke('pets:list'),
    get: (id) => ipcRenderer.invoke('pets:get', id),
    createFromSprite: (input: SpriteInput) => ipcRenderer.invoke('pets:create-from-sprite', input),
    replaceSprite: (petId: string, input) =>
      ipcRenderer.invoke('pets:replace-sprite', petId, input),
    rename: (petId: string, name: string) => ipcRenderer.invoke('pets:rename', petId, name),
    duplicate: (petId: string) => ipcRenderer.invoke('pets:duplicate', petId),
    remove: (petId: string) => ipcRenderer.invoke('pets:remove', petId),
    setActive: (petId: string) => ipcRenderer.invoke('pets:set-active', petId),
    saveAction: (petId: string, action: PetAction, assets: ActionAssets) =>
      ipcRenderer.invoke('pets:save-action', petId, action, assets),
    deleteAction: (petId: string, actionId: string) =>
      ipcRenderer.invoke('pets:delete-action', petId, actionId),
    resetActions: (petId: string) => ipcRenderer.invoke('pets:reset-actions', petId),
    importPack: () => ipcRenderer.invoke('pets:import'),
    exportPack: (petId: string) => ipcRenderer.invoke('pets:export', petId),
    setGreeting: (petId: string, greeting: string) =>
      ipcRenderer.invoke('pets:set-greeting', petId, greeting),
    onChange: (cb: (pets: PetPack[]) => void) => on('pets:changed', cb)
  },
  dialogs: {
    openImage: () => ipcRenderer.invoke('dialogs:image'),
    openImages: () => ipcRenderer.invoke('dialogs:images'),
    openAudio: () => ipcRenderer.invoke('dialogs:audio'),
    openDirectory: () => ipcRenderer.invoke('dialogs:directory')
  },
  pet: {
    getEnv: () => ipcRenderer.invoke('pet:get-env'),
    moveTo: (x: number, y: number) => ipcRenderer.send('pet:move-to', x, y),
    setHitbox: (rect: Rect | null) => ipcRenderer.send('pet:set-hitbox', rect),
    setChatOpen: (open: boolean) => ipcRenderer.invoke('pet:set-chat-open', open),
    beginDrag: () => ipcRenderer.send('pet:begin-drag'),
    endDrag: () => ipcRenderer.send('pet:end-drag'),
    setInteractive: (interactive: boolean) =>
      ipcRenderer.send('pet:set-interactive', interactive),
    contextMenu: () => ipcRenderer.send('pet:context-menu'),
    openSettings: (tab?: SettingsTab) => ipcRenderer.send('pet:open-settings', tab),
    openChat: () => ipcRenderer.send('pet:open-chat'),
    hide: () => ipcRenderer.send('pet:hide'),
    toggle: () => ipcRenderer.invoke('pet:toggle'),
    resetPosition: () => ipcRenderer.invoke('pet:reset-position'),
    testAction: (payload: TestActionPayload) => ipcRenderer.send('pet:test-action', payload),
    onCursor: (cb) => on('pet:cursor', cb),
    onInput: (cb) => on('pet:input', cb),
    onEnv: (cb) => on('pet:env', cb),
    onCommand: (cb) => on('pet:command', cb),
    onTestAction: (cb) => on('pet:test-action', cb),
    onContextMenu: (cb) => on('pet:context-menu', cb)
  },
  ai: {
    chat: (req: AiChatRequest) => ipcRenderer.send('ai:chat', req),
    cancel: (requestId: string) => ipcRenderer.send('ai:cancel', requestId),
    test: () => ipcRenderer.invoke('ai:test'),
    transcribe: (data: ArrayBuffer, mime: string) =>
      ipcRenderer.invoke('ai:transcribe', data, mime),
    onChunk: (cb) => on('ai:chunk', cb),
    onDone: (cb) => on('ai:done', cb),
    onError: (cb) => on('ai:error', cb)
  },
  history: {
    load: () => ipcRenderer.invoke('history:load'),
    save: (entries: ChatHistoryEntry[]) => ipcRenderer.invoke('history:save', entries),
    clear: () => ipcRenderer.invoke('history:clear')
  },
  system: {
    inputStatus: () => ipcRenderer.invoke('system:input-status'),
    restartInput: () => ipcRenderer.invoke('system:restart-input'),
    requestAccessibility: () => ipcRenderer.invoke('system:request-accessibility'),
    hotkeyStatus: () => ipcRenderer.invoke('system:hotkey-status'),
    autostart: {
      get: () => ipcRenderer.invoke('system:get-autostart'),
      set: (enabled: boolean) => ipcRenderer.invoke('system:set-autostart', enabled)
    },
    setAlwaysOnTop: (enabled: boolean) =>
      ipcRenderer.invoke('system:set-always-on-top', enabled)
  },
  settings: {
    onTab: (cb) => on('settings:tab', cb),
    onRequestClose: (cb) => on('settings:request-close', cb)
  }
}

contextBridge.exposeInMainWorld('deskpet', api)
