import {
  app,
  BrowserWindow,
  Menu,
  net,
  powerMonitor,
  protocol,
  screen,
  session,
  shell,
  type WebContents
} from 'electron'
import { readFile, realpath } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { extname, resolve, sep } from 'node:path'
import type { AppConfig, InputEvent, SettingsTab } from '../shared/types'
import { AiService } from './ai-service'
import { ConfigStore } from './config-store'
import { HotkeyManager } from './hotkeys'
import { InputMonitor } from './input-monitor'
import { registerIpc, type IpcContext } from './ipc'
import { log } from './logger'
import { petsDir } from './paths'
import { PetStore } from './pet-store'
import { PetWindow } from './pet-window'
import { getAutostart, setAutostart } from './platform'
import { SettingsWindow } from './settings-window'
import { TrayMenu } from './tray'

const ASSET_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm'
}

/**
 * On Wayland, Electron must be started with --ozone-platform=x11 before
 * Chromium initializes, otherwise it creates native Wayland surfaces which
 * cannot be positioned by the pet engine and (on GNOME) may never become
 * visible. app.commandLine.appendSwitch() runs too late for the ozone
 * platform selection, so relaunch the app once with the real CLI flag.
 */
function needsX11Relaunch(): boolean {
  if (!process.env.DISPLAY) return false
  if (process.env.DESKPET_OZONE_PLATFORM === 'wayland') return false
  if (!(process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY)) return false
  return !process.argv.some(
    (arg) => arg === '--ozone-platform' || arg.startsWith('--ozone-platform=')
  )
}

if (needsX11Relaunch()) {
  const execPath = process.env.APPIMAGE || process.execPath
  const args = [...process.argv.slice(1), '--ozone-platform=x11']
  try {
    console.log('[DeskPet] Wayland detected; relaunching with XWayland for window positioning.')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(execPath, args, {
      detached: true,
      stdio: 'ignore',
      env
    })
    child.unref()
    app.exit(0)
  } catch (error) {
    console.error('[DeskPet] Could not relaunch with XWayland, keeping the current platform.', error)
  }
}

app.commandLine.appendSwitch('enable-transparent-visuals')

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'deskpet',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
])

let store!: ConfigStore
let pets!: PetStore
let ai!: AiService
let hotkeys!: HotkeyManager
let tray!: TrayMenu
const settingsWindow = new SettingsWindow()
let input: InputMonitor | null = null
let petWindow: PetWindow | null = null
let quitting = false
let lastHotkeySignature = ''
let config!: AppConfig

function trustedWindow(sender: WebContents): boolean {
  return BrowserWindow.getAllWindows().some((win) => win.webContents === sender)
}

function openSettings(tab?: SettingsTab): void {
  settingsWindow.open(tab)
}

function openChat(): void {
  if (!petWindow) return
  petWindow.show()
  petWindow.sendCommand('open-chat')
}

function togglePet(): void {
  petWindow?.toggle()
  tray.refresh()
}

function openDataDir(): void {
  void shell.openPath(app.getPath('userData'))
}

function quit(): void {
  if (quitting) return
  quitting = true
  petWindow?.persistPosition()
  store.flush()
  input?.stop()
  hotkeys.dispose()
  tray.dispose()
  petWindow?.close()
  settingsWindow.close()
  app.quit()
}

function registerHotkeys(cfg: AppConfig): void {
  const signature = JSON.stringify(cfg.hotkeys)
  if (signature === lastHotkeySignature) return
  lastHotkeySignature = signature
  hotkeys.register(cfg.hotkeys, {
    togglePet: () => {
      petWindow?.toggle()
      tray.refresh()
    },
    openChat: () => openChat()
  })
}

function applyConfig(cfg: AppConfig): void {
  config = cfg
  petWindow?.applyConfig()
  if (cfg.interaction.inputMonitor) input?.start()
  else input?.stop()
  registerHotkeys(cfg)
}

function registerAssetProtocol(): void {
  const rootPath = resolve(petsDir())
  protocol.handle('deskpet', async (request) => {
    try {
      const root = await realpath(rootPath).catch(() => rootPath)
      const url = new URL(request.url)
      if (url.hostname !== 'assets') return new Response('Not found', { status: 404 })
      const parts = url.pathname
        .split('/')
        .filter(Boolean)
        .map((part) => decodeURIComponent(part))
      const [petId, ...rest] = parts
      if (!petId || rest.length === 0) return new Response('Not found', { status: 404 })
      const target = resolve(root, petId, ...rest)
      if (target !== root && !target.startsWith(`${root}${sep}`)) {
        return new Response('Forbidden', { status: 403 })
      }
      const real = await realpath(target)
      if (real !== root && !real.startsWith(`${root}${sep}`)) {
        return new Response('Forbidden', { status: 403 })
      }
      const data = await readFile(real)
      return new Response(new Uint8Array(data), {
        headers: {
          'content-type': ASSET_MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': 'no-cache'
        }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

function setupPermissions(): void {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((contents, permission, callback) => {
    const ours = BrowserWindow.fromWebContents(contents) !== null
    callback(ours && permission === 'media')
  })
  ses.setPermissionCheckHandler((contents, permission) => {
    return contents !== null && BrowserWindow.fromWebContents(contents) !== null && permission === 'media'
  })
}

function setupDisplayListeners(): void {
  const onChange = (): void => {
    petWindow?.applyConfig()
    petWindow?.sendEnvChanged()
    const win = petWindow?.window
    if (!win || win.isDestroyed()) return
    const bounds = win.getBounds()
    const visible = screen.getAllDisplays().some((display) => {
      const area = display.bounds
      return (
        bounds.x < area.x + area.width &&
        bounds.x + bounds.width > area.x &&
        bounds.y < area.y + area.height &&
        bounds.y + bounds.height > area.y
      )
    })
    if (!visible) void petWindow?.resetPosition()
  }
  screen.on('display-metrics-changed', onChange)
  screen.on('display-added', onChange)
  screen.on('display-removed', onChange)
}

function setupPowerListeners(): void {
  const idle = (): void => {
    petWindow?.sendInput({ kind: 'idle', at: Date.now() })
  }
  const wake = (): void => {
    petWindow?.sendInput({ kind: 'wake', at: Date.now() })
  }
  powerMonitor.on('lock-screen', idle)
  powerMonitor.on('suspend', idle)
  powerMonitor.on('unlock-screen', wake)
  powerMonitor.on('resume', () => {
    petWindow?.sendEnvChanged()
    wake()
  })
}

async function bootstrap(): Promise<void> {
  log.init()
  Menu.setApplicationMenu(null)

  store = new ConfigStore()
  config = store.load()
  pets = new PetStore(store)
  pets.init()
  config = store.get()

  registerAssetProtocol()
  setupPermissions()

  ai = new AiService(() => store.get())
  hotkeys = new HotkeyManager()
  tray = new TrayMenu()
  input = new InputMonitor(
    () => store.get(),
    (event: InputEvent) => petWindow?.sendInput(event)
  )
  petWindow = new PetWindow(store, {
    openSettings,
    quit,
    onVisibilityChanged: () => tray.refresh()
  })

  const ctx: IpcContext = {
    config: store,
    pets,
    petWindow,
    settings: settingsWindow,
    ai,
    input,
    hotkeys,
    tray,
    applyConfig,
    isTrusted: trustedWindow,
    quit,
    openChat,
    openSettings,
    openDataDir,
    togglePet
  }
  registerIpc(ctx)

  petWindow.create({
    hidden: process.argv.includes('--hidden') || process.argv.includes('--start-hidden')
  })

  tray.create({
    togglePet,
    showPet: () => {
      petWindow?.show()
      tray.refresh()
    },
    openChat,
    greet: () => petWindow?.sendCommand('say-hello'),
    openSettings: () => openSettings(),
    resetPosition: () => {
      void petWindow?.resetPosition()
    },
    openDataDir,
    quit,
    isPetVisible: () => Boolean(petWindow?.window?.isVisible()),
    getAutostart,
    setAutostart: (enabled: boolean) => {
      const result = setAutostart(enabled)
      const next = store.patch({ launchAtLogin: result })
      settingsWindow.broadcast('config:changed', next)
      return result
    }
  })

  setupDisplayListeners()
  setupPowerListeners()
  applyConfig(config)
  if (config.launchAtLogin) setAutostart(true)
  const actualAutostart = getAutostart()
  if (actualAutostart !== config.launchAtLogin) {
    config = store.patch({ launchAtLogin: actualAutostart })
  }
  if (
    store.isFirstRun ||
    process.argv.includes('--settings') ||
    process.argv.includes('--open-settings')
  ) {
    settingsWindow.open()
  }

  log.info('DeskPet ready', {
    version: app.getVersion(),
    platform: 'linux',
    electron: process.versions.electron,
    activePet: config.activePetId,
    userData: app.getPath('userData'),
    input: input.status()
  })
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    petWindow?.show()
    settingsWindow.open()
    tray.refresh()
  })

  app.on('activate', () => {
    if (!petWindow?.isOpen) petWindow?.create()
    else petWindow?.show()
  })

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
  })

  app.on('window-all-closed', () => {
    if (!quitting) quit()
  })

  app.on('before-quit', () => {
    quitting = true
    petWindow?.persistPosition()
    if (store) store.flush()
    input?.stop()
    hotkeys?.dispose()
    tray?.dispose()
  })

  app
    .whenReady()
    .then(bootstrap)
    .catch((error) => {
      log.error('DeskPet failed to start', error)
      app.quit()
    })
}
