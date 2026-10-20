import {
  app,
  dialog,
  ipcMain,
  nativeImage,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type {
  ActionAssets,
  AiChatRequest,
  AppConfig,
  ChatHistoryEntry,
  DeepPartial,
  DialogImage,
  PetAction,
  SettingsTab,
  SpriteInput
} from '../shared/types'
import type { AiService } from './ai-service'
import type { ConfigStore } from './config-store'
import type { HotkeyManager } from './hotkeys'
import type { InputMonitor } from './input-monitor'
import type { PetStore } from './pet-store'
import type { PetWindow } from './pet-window'
import type { SettingsWindow } from './settings-window'
import type { TrayMenu } from './tray'
import { log } from './logger'
import { chatFile, configFile, logFile, petsDir, userDataDir } from './paths'
import { getAutostart, setAutostart } from './platform'

const VALID_TABS: SettingsTab[] = [
  'pet',
  'studio',
  'actions',
  'voice',
  'interaction',
  'ai',
  'about'
]

export interface IpcContext {
  config: ConfigStore
  pets: PetStore
  petWindow: PetWindow
  settings: SettingsWindow
  ai: AiService
  input: InputMonitor
  hotkeys: HotkeyManager
  tray: TrayMenu
  applyConfig: (config: AppConfig) => void
  isTrusted: (sender: WebContents) => boolean
  quit: () => void
  openChat: () => void
  openSettings: (tab?: SettingsTab) => void
  openDataDir: () => void
  togglePet: () => void
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}

const AUDIO_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm'
}

function guard(ctx: IpcContext, event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  if (ctx.isTrusted(event.sender)) return true
  log.warn(`Blocked IPC from an untrusted sender: ${event.sender.getURL()}`)
  return false
}

function readImage(path: string): DialogImage | null {
  try {
    const info = statSync(path)
    if (info.size > 30 * 1024 * 1024) throw new Error('图片超过 30MB')
    const ext = extname(path).toLowerCase()
    const mime = IMAGE_MIME[ext] ?? 'image/png'
    const buffer = readFileSync(path)
    let width = 0
    let height = 0
    try {
      const size = nativeImage.createFromBuffer(buffer).getSize()
      width = size.width
      height = size.height
    } catch {
      /* the renderer can still decode the data URL */
    }
    return {
      name: path.split(/[\\/]/).pop() ?? 'image',
      path,
      dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
      width,
      height
    }
  } catch (error) {
    log.warn(`Could not read image ${path}`, error)
    throw new Error(`读取图片失败：${(error as Error).message}`)
  }
}

function readHistory(): ChatHistoryEntry[] {
  try {
    const file = chatFile()
    if (!existsSync(file)) return []
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is ChatHistoryEntry => {
        if (!item || typeof item !== 'object') return false
        const entry = item as Record<string, unknown>
        return (
          (entry.role === 'user' || entry.role === 'assistant') &&
          typeof entry.content === 'string'
        )
      })
      .slice(-60)
      .map((entry) => ({
        role: entry.role,
        content: entry.content.slice(0, 4000),
        at: typeof entry.at === 'number' ? entry.at : Date.now()
      }))
  } catch {
    return []
  }
}

function writeHistory(entries: ChatHistoryEntry[]): void {
  const clean = (Array.isArray(entries) ? entries : [])
    .filter(
      (entry) =>
        entry &&
        (entry.role === 'user' || entry.role === 'assistant') &&
        typeof entry.content === 'string'
    )
    .slice(-60)
    .map((entry) => ({
      role: entry.role,
      content: entry.content.slice(0, 4000),
      at: typeof entry.at === 'number' ? entry.at : Date.now()
    }))
  const file = chatFile()
  try {
    const tmp = `${file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  } catch (error) {
    log.warn('Could not save chat history', error)
  }
}

export function registerIpc(ctx: IpcContext): void {
  const notifyConfig = (config: AppConfig = ctx.config.get()): void => {
    ctx.petWindow.sendConfigChanged()
    ctx.settings.broadcast('config:changed', config)
  }

  const notifyPets = (config: AppConfig = ctx.config.get()): void => {
    notifyConfig(config)
    ctx.settings.broadcast('pets:changed', ctx.pets.list())
  }

  const handle = (
    channel: string,
    fn: (event: IpcMainInvokeEvent, ...args: any[]) => any
  ): void => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!guard(ctx, event)) throw new Error('Forbidden')
      return fn(event, ...args)
    })
  }

  /* --------------------------------------------------------------- config */

  handle('config:get', () => ctx.config.get())

  handle('config:patch', (_event, patch: DeepPartial<AppConfig>) => {
    const next = ctx.config.patch(patch ?? {})
    ctx.applyConfig(next)
    notifyConfig(next)
    return next
  })

  handle('config:reset', () => {
    const next = ctx.config.reset()
    ctx.applyConfig(next)
    notifyPets(next)
    return next
  })

  /* ----------------------------------------------------------------- pets */

  handle('pets:list', () => ctx.pets.list())
  handle('pets:get', (_event, id: string) => ctx.pets.get(String(id)))

  handle('pets:create-from-sprite', (_event, input: SpriteInput) => {
    const pack = ctx.pets.createFromSprite(input)
    notifyPets()
    return pack
  })

  handle('pets:replace-sprite', (_event, petId: string, input: Omit<SpriteInput, 'name'>) => {
    const pack = ctx.pets.replaceSprite(String(petId), input)
    notifyPets()
    return pack
  })

  handle('pets:rename', (_event, petId: string, name: string) => {
    const pack = ctx.pets.rename(String(petId), String(name))
    notifyPets()
    return pack
  })

  handle('pets:set-greeting', (_event, petId: string, greeting: string) => {
    const pack = ctx.pets.setGreeting(String(petId), String(greeting))
    notifyPets()
    return pack
  })

  handle('pets:duplicate', (_event, petId: string) => {
    const pack = ctx.pets.duplicate(String(petId))
    notifyPets()
    return pack
  })

  handle('pets:remove', (_event, petId: string) => {
    const result = ctx.pets.remove(String(petId))
    notifyPets()
    return result
  })

  handle('pets:set-active', (_event, petId: string) => {
    const pack = ctx.pets.setActive(String(petId))
    notifyPets()
    return pack
  })

  handle(
    'pets:save-action',
    (_event, petId: string, action: PetAction, assets: ActionAssets) => {
      const pack = ctx.pets.saveAction(String(petId), action, assets ?? {})
      notifyPets()
      return pack
    }
  )

  handle('pets:delete-action', (_event, petId: string, actionId: string) => {
    const pack = ctx.pets.deleteAction(String(petId), String(actionId))
    notifyPets()
    return pack
  })

  handle('pets:reset-actions', (_event, petId: string) => {
    const pack = ctx.pets.resetActions(String(petId))
    notifyPets()
    return pack
  })

  handle('pets:import', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择桌宠文件夹（里面应有 pet.json）',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    const pack = ctx.pets.importFromDirectory(result.filePaths[0])
    ctx.pets.setActive(pack.id)
    notifyPets()
    return ctx.pets.get(pack.id)
  })

  handle('pets:export', async (_event, petId: string) => {
    const result = await dialog.showOpenDialog({
      title: '选择导出的目标文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return ctx.pets.exportToDirectory(String(petId), result.filePaths[0])
  })

  /* -------------------------------------------------------------- dialogs */

  handle('dialogs:image', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择一张图片',
      properties: ['openFile'],
      filters: [
        {
          name: '图片',
          extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']
        }
      ]
    })
    if (result.canceled || !result.filePaths[0]) return null
    return readImage(result.filePaths[0])
  })

  handle('dialogs:images', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择序列帧图片（可多选）',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
    if (result.canceled) return []
    return result.filePaths
      .slice(0, 80)
      .map((path) => {
        try {
          return readImage(path)
        } catch {
          return null
        }
      })
      .filter((image): image is DialogImage => image !== null)
  })

  handle('dialogs:audio', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择音效或语音文件',
      properties: ['openFile'],
      filters: [{ name: '音频', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'webm'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    const info = statSync(path)
    if (info.size > 20 * 1024 * 1024) throw new Error('音频文件不能超过 20MB')
    const ext = extname(path).toLowerCase()
    const mime = AUDIO_MIME[ext] ?? 'audio/mpeg'
    const buffer = readFileSync(path)
    return {
      name: path.split(/[\\/]/).pop() ?? 'sound',
      path,
      dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
      ext: ext.replace('.', '')
    }
  })

  handle('dialogs:directory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  /* ----------------------------------------------------------- pet window */

  handle('pet:get-env', () => ctx.petWindow.getEnv())

  ipcMain.on('pet:move-to', (event, x: number, y: number) => {
    if (!guard(ctx, event)) return
    ctx.petWindow.moveTo(Number(x), Number(y))
  })

  ipcMain.on('pet:set-hitbox', (event, rect: unknown) => {
    if (!guard(ctx, event)) return
    if (!rect || typeof rect !== 'object') {
      ctx.petWindow.setHitbox(null)
      return
    }
    const value = rect as { x: number; y: number; width: number; height: number }
    ctx.petWindow.setHitbox({
      x: Number(value.x),
      y: Number(value.y),
      width: Number(value.width),
      height: Number(value.height)
    })
  })

  handle('pet:set-chat-open', async (_event, open: boolean) =>
    ctx.petWindow.setChatOpen(Boolean(open))
  )

  ipcMain.on('pet:begin-drag', (event) => {
    if (!guard(ctx, event)) return
    ctx.petWindow.beginDrag()
  })

  ipcMain.on('pet:end-drag', (event) => {
    if (!guard(ctx, event)) return
    ctx.petWindow.endDrag()
  })

  ipcMain.on('pet:set-interactive', (event, interactive: boolean) => {
    if (!guard(ctx, event)) return
    ctx.petWindow.setInteractive(Boolean(interactive))
  })

  ipcMain.on('pet:context-menu', (event) => {
    if (!guard(ctx, event)) return
    ctx.petWindow.contextMenu()
  })

  ipcMain.on('pet:test-action', (event, payload: unknown) => {
    if (!guard(ctx, event)) return
    if (!payload || typeof payload !== 'object') return
    const data = payload as { action?: PetAction; frames?: unknown; sound?: unknown }
    if (!data.action || typeof data.action !== 'object') return
    ctx.petWindow.sendTestAction({
      action: data.action,
      frames: Array.isArray(data.frames)
        ? data.frames.filter((item): item is string => typeof item === 'string').slice(0, 80)
        : [],
      sound: typeof data.sound === 'string' ? data.sound : null
    })
  })

  handle('pet:toggle', () => ctx.petWindow.toggle())

  ipcMain.on('pet:hide', (event) => {
    if (!guard(ctx, event)) return
    ctx.petWindow.hide()
  })

  handle('pet:reset-position', async () => ctx.petWindow.resetPosition())

  ipcMain.on('pet:open-settings', (event, tab?: SettingsTab) => {
    if (!guard(ctx, event)) return
    ctx.openSettings(VALID_TABS.includes(tab as SettingsTab) ? tab : undefined)
  })

  ipcMain.on('pet:open-chat', (event) => {
    if (!guard(ctx, event)) return
    ctx.openChat()
  })

  /* ------------------------------------------------------------------- AI */

  ipcMain.on('ai:chat', (event, request: AiChatRequest) => {
    if (!guard(ctx, event)) return
    if (!request || typeof request.requestId !== 'string' || !Array.isArray(request.messages)) return
    const sender = event.sender
    const messages = request.messages
      .filter(
        (message) =>
          message &&
          (message.role === 'system' || message.role === 'user' || message.role === 'assistant') &&
          typeof message.content === 'string'
      )
      .slice(-40)
      .map((message) => ({
        role: message.role,
        content: message.content.slice(0, 8000)
      }))
    const deliver = (channel: string, payload: unknown): void => {
      if (!sender.isDestroyed()) sender.send(channel, payload)
    }
    void ctx.ai.chat({ requestId: request.requestId, messages }, {
      onChunk: (delta) => deliver('ai:chunk', { requestId: request.requestId, delta }),
      onDone: (text) => deliver('ai:done', { requestId: request.requestId, text }),
      onError: (message) => deliver('ai:error', { requestId: request.requestId, message })
    })
  })

  ipcMain.on('ai:cancel', (event, requestId: string) => {
    if (!guard(ctx, event)) return
    if (typeof requestId === 'string') ctx.ai.cancel(requestId)
  })

  handle('ai:test', () => ctx.ai.test())

  handle('ai:transcribe', async (_event, data: ArrayBuffer | Uint8Array, mime: string) => {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer
    return ctx.ai.transcribe(buffer, String(mime || 'audio/webm'))
  })

  /* -------------------------------------------------------------- history */

  handle('history:load', () => readHistory())
  handle('history:save', (_event, entries: ChatHistoryEntry[]) => writeHistory(entries))
  handle('history:clear', () => {
    writeHistory([])
    return true
  })

  /* --------------------------------------------------------------- system */

  handle('system:input-status', () => ctx.input.status())
  handle('system:restart-input', () => ctx.input.restart())
  handle('system:hotkey-status', () => ctx.hotkeys.get())

  handle('system:get-autostart', () => getAutostart())
  handle('system:set-autostart', (_event, enabled: boolean) => {
    const result = setAutostart(Boolean(enabled))
    const next = ctx.config.patch({ launchAtLogin: result })
    notifyConfig(next)
    ctx.tray.refresh()
    return result
  })

  handle('system:set-always-on-top', (_event, enabled: boolean) => {
    const next = ctx.config.patch({ pet: { alwaysOnTop: Boolean(enabled) } })
    ctx.applyConfig(next)
    notifyConfig(next)
  })

  /* ------------------------------------------------------------------ app */

  handle('app:info', () => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
    platform: 'linux',
    arch: process.arch,
    userData: userDataDir(),
    petsDir: petsDir(),
    configFile: configFile(),
    logFile: logFile(),
    packaged: app.isPackaged
  }))

  handle('app:quit', () => ctx.quit())

  handle('app:relaunch', () => {
    app.relaunch()
    ctx.quit()
  })

  handle('app:open-external', async (_event, url: string) => {
    const target = String(url)
    if (!/^https?:\/\//i.test(target)) throw new Error('Only http(s) links can be opened')
    await shell.openExternal(target)
  })

  handle('app:show-item', (_event, path: string) => {
    shell.showItemInFolder(String(path))
  })

  handle('app:open-path', async (_event, path: string) => {
    const target = String(path)
    if (!existsSync(target)) throw new Error('路径不存在')
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
  })
}
