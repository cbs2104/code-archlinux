import { app } from 'electron'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { log } from './logger'

function autostartFile(): string {
  return join(app.getPath('home'), '.config', 'autostart', 'deskpet.desktop')
}

export function getAutostart(): boolean {
  return existsSync(autostartFile())
}

export function setAutostart(enabled: boolean): boolean {
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
        'Comment=A desktop pet for Linux',
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
