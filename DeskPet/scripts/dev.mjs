/**
 * Starts electron-vite (dev or preview) with the Ozone platform passed as a
 * real Electron CLI argument. app.commandLine.appendSwitch() is too late for
 * Ozone selection, and native Wayland cannot position the pet window, so on
 * Wayland we must pass --ozone-platform=x11 to the Electron process itself.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const pkgPath = require.resolve('electron-vite/package.json')
const pkg = require(pkgPath)
const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['electron-vite']
const cli = resolve(dirname(pkgPath), bin)

const env = { ...process.env }
const isWayland =
  process.platform === 'linux' &&
  Boolean(env.DISPLAY) &&
  (env.XDG_SESSION_TYPE === 'wayland' || Boolean(env.WAYLAND_DISPLAY)) &&
  env.DESKPET_OZONE_PLATFORM !== 'wayland'

const userArgs = process.argv.slice(2)
const mode = userArgs[0] === 'preview' ? 'preview' : 'dev'
if (mode === 'preview') userArgs.shift()
const electronArgs = []
if (isWayland && !userArgs.some((item) => item.startsWith('--ozone-platform'))) {
  electronArgs.push('--ozone-platform=x11')
  console.log('[DeskPet] Wayland session detected, starting Electron with --ozone-platform=x11')
}

// electron-vite forwards everything after `--` as real Electron CLI args.
const forwarded = [...userArgs, ...electronArgs]
const args = [cli, mode]
if (forwarded.length > 0) args.push('--', ...forwarded)

const child = spawn(process.execPath, args, {
  stdio: 'inherit',
  env
})

const signals =
  process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP']
for (const signal of signals) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal)
  })
}

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 0 : 1))
})
