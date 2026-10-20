import { app } from 'electron'
import { join } from 'node:path'

export function userDataDir(): string {
  return app.getPath('userData')
}

export function petsDir(): string {
  return join(userDataDir(), 'pets')
}

export function configFile(): string {
  return join(userDataDir(), 'config.json')
}

export function chatFile(): string {
  return join(userDataDir(), 'chat.json')
}

export function logFile(): string {
  return join(userDataDir(), 'deskpet.log')
}

/** App icon used by the tray and the settings window. */
export function iconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')
}

export function preloadPath(): string {
  return join(__dirname, '../preload/index.js')
}

export function rendererUrl(page: 'pet' | 'settings'): { dev?: string; file: string } {
  const dev = process.env['ELECTRON_RENDERER_URL']
  return {
    dev: dev ? `${dev}/${page}/index.html` : undefined,
    file: join(__dirname, `../renderer/${page}/index.html`)
  }
}
