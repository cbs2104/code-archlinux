import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { log } from './logger'

/** One-time platform specific setup that must run before windows open. */
export function applyPlatformStartup(): void {
  app.setAppUserModelId('com.deskpet.app')
  if (process.platform === 'darwin') {
    try {
      app.setActivationPolicy('accessory')
      app.dock?.hide()
    } catch (error) {
      log.warn('Could not hide the macOS dock icon', error)
    }
  }
}

function autostartFile(): string {
  return join(app.getPath('home'), '.config', 'autostart', 'deskpet.desktop')
}

export function getAutostart(): boolean {
  if (process.platform === 'linux') return existsSync(autostartFile())
  try {
    return app.getLoginItemSettings().openAtLogin
  } catch {
    return false
  }
}

export function setAutostart(enabled: boolean): boolean {
  if (process.platform === 'linux') {
    const file = autostartFile()
    try {
      if (!enabled) {
        if (existsSync(file)) rmSync(file, { force: true })
        return false
      }
      mkdirSync(dirname(file), { recursive: true })
      const exec = process.env.APPIMAGE || process.execPath
      const appArgs = app.isPackaged ? '--hidden' : `"${app.getAppPath()}" --hidden`
      writeFileSync(
        file,
        [
          '[Desktop Entry]',
          'Type=Application',
          'Name=DeskPet',
          'Comment=A cross-platform desktop pet',
          `Exec="${exec}" ${appArgs}`,
          'Terminal=false',
          'X-GNOME-Autostart-enabled=true',
          'StartupNotify=false',
          ''
        ].join('\n'),
        'utf8'
      )
      return true
    } catch (error) {
      log.warn('Could not update the Linux autostart entry', error)
      return false
    }
  }
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      args: enabled ? ['--hidden'] : []
    })
    return app.getLoginItemSettings().openAtLogin
  } catch (error) {
    log.warn('Could not update login item settings', error)
    return false
  }
}

interface MenuHandlers {
  openSettings: () => void
  openChat: () => void
  togglePet: () => void
  quit: () => void
}

/** On Windows/Linux the app has no menu bar; macOS needs the standard roles. */
export function installApplicationMenu(handlers: MenuHandlers): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: '桌宠',
      submenu: [
        { label: '和桌宠聊天', accelerator: 'Command+K', click: handlers.openChat },
        { label: '显示 / 隐藏桌宠', click: handlers.togglePet },
        {
          label: '设置…',
          accelerator: 'Command+,',
          click: handlers.openSettings
        },
        { type: 'separator' },
        { label: '退出 DeskPet', role: 'quit', click: handlers.quit }
      ]
    },
    { role: 'editMenu' },
    { role: 'windowMenu' }
  ]
  if (!app.isPackaged) {
    template.push({
      label: '开发',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }]
    })
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
