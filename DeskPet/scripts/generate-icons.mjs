#!/usr/bin/env node
/**
 * Regenerates build/icon.png and build/icon.ico from build/icon.svg.
 *
 * Requires one of: rsvg-convert, ImageMagick (magick / convert).
 * On macOS, iconutil is used to also produce icon.icns when available.
 * The generated files are committed, so normal development does not need this
 * script.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const svg = join(root, 'build', 'icon.svg')
const png = join(root, 'build', 'icon.png')
const ico = join(root, 'build', 'icon.ico')
const icns = join(root, 'build', 'icon.icns')

function which(command) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], {
      stdio: 'ignore'
    })
    return true
  } catch {
    return false
  }
}

function run(command, args) {
  console.log(`$ ${command} ${args.join(' ')}`)
  execFileSync(command, args, { stdio: 'inherit' })
}

if (!existsSync(svg)) {
  console.error(`Missing ${svg}`)
  process.exit(1)
}

if (which('rsvg-convert')) {
  run('rsvg-convert', ['-w', '1024', '-h', '1024', svg, '-o', png])
} else if (which('magick')) {
  run('magick', ['-background', 'none', svg, '-resize', '1024x1024', png])
} else if (which('convert')) {
  run('convert', ['-background', 'none', svg, '-resize', '1024x1024', png])
} else {
  console.error('Install librsvg (rsvg-convert) or ImageMagick to render build/icon.svg')
  process.exit(1)
}

const magick = which('magick') ? 'magick' : which('convert') ? 'convert' : null
if (magick) {
  run(magick, [png, '-define', 'icon:auto-resize=256,128,64,48,32,16', ico])
} else {
  console.warn('ImageMagick not found; skipped build/icon.ico')
}

if (process.platform === 'darwin' && which('iconutil') && magick) {
  const iconset = join(root, 'build', 'icon.iconset')
  rmSync(iconset, { recursive: true, force: true })
  mkdirSync(iconset, { recursive: true })
  const sizes = [16, 32, 64, 128, 256, 512]
  for (const size of sizes) {
    run(magick, [png, '-resize', `${size}x${size}`, join(iconset, `icon_${size}x${size}.png`)])
    run(magick, [
      png,
      '-resize',
      `${size * 2}x${size * 2}`,
      join(iconset, `icon_${size}x${size}@2x.png`)
    ])
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', icns])
  rmSync(iconset, { recursive: true, force: true })
  console.log(`Wrote ${icns}`)
}

console.log(`Wrote ${png}${existsSync(ico) ? ` and ${ico}` : ''}`)
