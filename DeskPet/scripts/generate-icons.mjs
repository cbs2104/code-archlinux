#!/usr/bin/env node
/**
 * Regenerates build/icon.png from build/icon.svg for Linux packaging.
 *
 * Requires one of: rsvg-convert, ImageMagick (magick / convert).
 * The generated files are committed, so normal development does not need this
 * script.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const svg = join(root, 'build', 'icon.svg')
const png = join(root, 'build', 'icon.png')

function which(command) {
  try {
    execFileSync('which', [command], { stdio: 'ignore' })
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

console.log(`Wrote ${png}`)
