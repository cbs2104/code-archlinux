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
    const flatpakId = process.env.FLATPAK_ID
    const exec = flatpakId
      ? `flatpak run ${flatpakId}`
      : `"${process.env.APPIMAGE || process.execPath}" ${
          app.isPackaged ? '' : `"${app.getAppPath()}"`
        }`.trim()
    writeFileSync(
      file,
      [
        '[Desktop Entry]',
        'Type=Application',
        'Name=DeskPet',
        'Comment=A desktop pet for Linux',
        `Exec=${exec}`,
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
