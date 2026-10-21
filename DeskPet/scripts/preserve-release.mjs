#!/usr/bin/env node
/**
 * Keeps every packaged version under release/<version>/.
 *
 * electron-builder already puts the version in each filename, but rebuilding a
 * different version used to leave the previous files only in the flat release
 * directory. This helper copies the artifacts for one version (or all versions
 * found at the release root) into a versioned subdirectory and writes a
 * SHA256SUMS file next to them. It never deletes an older version.
 *
 * Usage:
 *   node scripts/preserve-release.mjs             # current package.json version
 *   node scripts/preserve-release.mjs 1.1.0       # archive one version
 *   node scripts/preserve-release.mjs --all       # archive every version
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = join(root, 'release')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const args = process.argv.slice(2)
const all = args.includes('--all')
const requestedVersion = args.find((arg) => !arg.startsWith('--'))
const currentVersion = requestedVersion ?? packageJson.version

// Release artifact names are produced by electron-builder and scripts/build-flatpak.sh:
// DeskPet-<version>-x86_64.AppImage, .flatpak, .deb, .rpm, .pacman
// Optional .blockmap files are kept too.
const artifactPattern =
  /^DeskPet-(.+)-x86_64\.(AppImage|flatpak|deb|rpm|pacman|snap)(?:\.blockmap)?$/

if (!existsSync(releaseDir)) {
  console.error(`No release directory at ${releaseDir}. Build an artifact first.`)
  process.exit(1)
}

const entries = readdirSync(releaseDir)
  .map((name) => ({ name, match: name.match(artifactPattern) }))
  .filter((entry) => {
    if (!entry.match) return false
    try {
      return statSync(join(releaseDir, entry.name)).isFile()
    } catch {
      return false
    }
  })

const selected = all
  ? entries
  : entries.filter((entry) => entry.match?.[1] === currentVersion)

if (selected.length === 0) {
  console.log(`No release artifacts for ${all ? 'any version' : currentVersion} in ${releaseDir}.`)
  process.exit(0)
}

const byVersion = new Map()
for (const entry of selected) {
  const version = entry.match?.[1]
  if (!version) continue
  const list = byVersion.get(version) ?? []
  list.push(entry.name)
  byVersion.set(version, list)
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

for (const [version, names] of byVersion) {
  const destinationDir = join(releaseDir, version)
  mkdirSync(destinationDir, { recursive: true })
  for (const name of names) {
    copyFileSync(join(releaseDir, name), join(destinationDir, name))
  }

  const archived = readdirSync(destinationDir)
    .filter((name) => {
      if (!artifactPattern.test(name)) return false
      try {
        return statSync(join(destinationDir, name)).isFile()
      } catch {
        return false
      }
    })
    .sort()

  const sums = archived.map((name) => `${sha256(join(destinationDir, name))}  ${name}`).join('\n')
  writeFileSync(join(destinationDir, 'SHA256SUMS'), `${sums}\n`, 'utf8')
  console.log(`Archived ${names.length} artifact(s) for ${version} -> ${destinationDir}`)
}
