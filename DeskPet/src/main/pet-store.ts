import { randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'
import { createBuiltinPack, defaultActions } from '../shared/defaults'
import type {
  ActionAssets,
  PetAction,
  PetPack,
  PetSprite,
  PetTrigger,
  PetAnimation,
  SpriteInput
} from '../shared/types'
import { PET_ANIMATIONS, PET_SCHEMA, PET_TRIGGERS } from '../shared/types'
import type { ConfigStore } from './config-store'
import { log } from './logger'
import { petsDir } from './paths'

const MAX_FRAMES = 80
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac'
}

const TRIGGER_SET = new Set<PetTrigger>(PET_TRIGGERS.map((item) => item.value))
const ANIMATION_SET = new Set<PetAnimation>(PET_ANIMATIONS.map((item) => item.value))

export class PetStore {
  private readonly root = petsDir()

  constructor(private readonly config: ConfigStore) {}

  init(): void {
    mkdirSync(this.root, { recursive: true })
    if (!existsSync(join(this.root, 'builtin', 'pet.json'))) {
      this.writePack(createBuiltinPack())
    }
    const active = this.config.get().activePetId
    try {
      this.get(active)
    } catch {
      this.config.patch({ activePetId: 'builtin' })
    }
  }

  list(): PetPack[] {
    let entries: string[] = []
    try {
      entries = readdirSync(this.root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      return []
    }
    const packs: PetPack[] = []
    for (const id of entries) {
      try {
        const pack = this.readPack(id)
        if (pack) packs.push(pack)
      } catch (error) {
        log.warn(`Skipping invalid pet pack "${id}"`, error)
      }
    }
    packs.sort((a, b) => {
      if (a.kind === 'builtin') return -1
      if (b.kind === 'builtin') return 1
      return b.updatedAt - a.updatedAt
    })
    return packs
  }

  get(id: string): PetPack {
    const pack = this.readPack(id)
    if (!pack) throw new Error('桌宠不存在')
    return pack
  }

  private packDir(id: string): string {
    if (!safeSegment(id) || id === 'asset') throw new Error('无效的桌宠 ID')
    return join(this.root, id)
  }

  private assetFile(petId: string, relativePath: string, mustExist = false): string {
    const dir = this.packDir(petId)
    const normalized = relativePath.replace(/\\/g, '/')
    if (normalized.startsWith('/') || normalized.includes('\0')) {
      throw new Error('无效的资源路径')
    }
    const target = resolve(dir, normalized)
    if (target !== dir && !target.startsWith(`${dir}${sep}`)) {
      throw new Error('资源路径超出桌宠目录')
    }
    if (mustExist && !existsSync(target)) {
      throw new Error(`缺少资源文件：${relativePath}`)
    }
    return target
  }

  private readPack(id: string): PetPack | null {
    const dir = this.packDir(id)
    const file = join(dir, 'pet.json')
    if (!existsSync(file)) return null
    let raw: Partial<PetPack>
    try {
      raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<PetPack>
    } catch (error) {
      log.warn(`pet.json in ${id} is not valid JSON`, error)
      return null
    }
    if (raw.schema !== PET_SCHEMA) {
      log.warn(`pet.json in ${id} has an unsupported schema`)
      return null
    }
    const sprite = (raw.sprite ?? {}) as Partial<PetSprite>
    let normalizedSprite: PetSprite = {
      kind: sprite.kind === 'image' ? 'image' : 'builtin',
      asset: typeof sprite.asset === 'string' ? sprite.asset : null,
      width: clampInt(sprite.width, 1, 4096, 200),
      height: clampInt(sprite.height, 1, 4096, 200)
    }
    if (normalizedSprite.kind === 'image') {
      if (!normalizedSprite.asset) {
        normalizedSprite = { kind: 'builtin', asset: null, width: 200, height: 200 }
      } else {
        this.assetFile(id, normalizedSprite.asset, true)
      }
    }
    const actions = Array.isArray(raw.actions) && raw.actions.length > 0
      ? raw.actions.map((action, index) => normalizeAction(action, index))
      : defaultActions()
    for (const action of actions) {
      action.frames = action.frames.filter((frame) => {
        try {
          this.assetFile(id, frame, true)
          return true
        } catch {
          log.warn(`Ignoring missing frame "${frame}" in pet ${id}`)
          return false
        }
      })
      if (action.sound) {
        try {
          this.assetFile(id, action.sound, true)
        } catch {
          log.warn(`Ignoring missing sound "${action.sound}" in pet ${id}`)
          action.sound = null
        }
      }
    }
    return {
      schema: PET_SCHEMA,
      id,
      name: safeName(raw.name, '未命名桌宠'),
      author: safeName(raw.author, '未知作者', 60),
      version: safeName(raw.version, '1.0.0', 20),
      kind: id === 'builtin' ? 'builtin' : 'custom',
      createdAt: clampInt(raw.createdAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
      updatedAt: clampInt(raw.updatedAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
      sprite: normalizedSprite,
      actions,
      greeting: typeof raw.greeting === 'string' ? raw.greeting.slice(0, 200) : ''
    }
  }

  private writePack(pack: PetPack): void {
    const dir = this.packDir(pack.id)
    mkdirSync(dir, { recursive: true })
    const payload: PetPack = { ...pack, updatedAt: Date.now() }
    writeFileSync(join(dir, 'pet.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  }

  private writeDataUrlFile(dir: string, baseName: string, dataUrl: string): string {
    const { mime, base64 } = parseDataUrl(dataUrl)
    const ext = MIME_EXT[mime]
    if (!ext) throw new Error(`不支持的文件类型：${mime}`)
    mkdirSync(dir, { recursive: true })
    const target = join(dir, `${baseName}.${ext}`)
    writeFileSync(target, Buffer.from(base64, 'base64'))
    return ext
  }

  private assertNoSymlinks(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error('桌宠包不能包含符号链接')
      }
      if (entry.isDirectory()) this.assertNoSymlinks(full)
    }
  }

  private deleteAsset(petId: string, relativePath: string | null): void {
    if (!relativePath) return
    try {
      const file = this.assetFile(petId, relativePath)
      rmSync(file, { force: true })
    } catch (error) {
      log.warn(`Could not delete asset ${relativePath}`, error)
    }
  }

  createFromSprite(input: SpriteInput): PetPack {
    const id = randomUUID()
    const name = safeName(input.name, '我的桌宠')
    const width = clampInt(input.width, 1, 4096, 200)
    const height = clampInt(input.height, 1, 4096, 200)
    const dir = this.packDir(id)
    mkdirSync(dir, { recursive: true })
    const ext = this.writeDataUrlFile(dir, 'sprite', input.dataUrl)
    const pack = createBuiltinPack()
    const now = Date.now()
    pack.id = id
    pack.kind = 'custom'
    pack.name = name
    pack.author = '我'
    pack.createdAt = now
    pack.updatedAt = now
    pack.sprite = { kind: 'image', asset: `sprite.${ext}`, width, height }
    pack.greeting = `${name} 来啦！`
    this.writePack(pack)
    this.config.patch({ activePetId: id })
    log.info(`Created pet "${name}" (${id}) from image`)
    return this.get(id)
  }

  replaceSprite(petId: string, input: Omit<SpriteInput, 'name'>): PetPack {
    const pack = this.get(petId)
    if (pack.kind === 'builtin') {
      throw new Error('内置桌宠不能修改形象，请先导入图片新建一个桌宠')
    }
    const dir = this.packDir(petId)
    const oldAsset = pack.sprite.asset
    const ext = this.writeDataUrlFile(dir, 'sprite-new', input.dataUrl)
    const newAsset = `sprite-new.${ext}`
    pack.sprite = {
      kind: 'image',
      asset: newAsset,
      width: clampInt(input.width, 1, 4096, pack.sprite.width),
      height: clampInt(input.height, 1, 4096, pack.sprite.height)
    }
    this.writePack(pack)
    if (oldAsset !== newAsset) this.deleteAsset(petId, oldAsset)
    return this.get(petId)
  }

  rename(petId: string, name: string): PetPack {
    const pack = this.get(petId)
    pack.name = safeName(name, pack.name)
    this.writePack(pack)
    return this.get(petId)
  }

  setGreeting(petId: string, greeting: string): PetPack {
    const pack = this.get(petId)
    pack.greeting = typeof greeting === 'string' ? greeting.slice(0, 200) : ''
    this.writePack(pack)
    return this.get(petId)
  }

  duplicate(petId: string): PetPack {
    const source = this.get(petId)
    if (source.kind === 'builtin') {
      throw new Error('内置桌宠使用程序内置形象，无法复制；请用「抠图工坊」新建桌宠')
    }
    const id = randomUUID()
    cpSync(this.packDir(petId), this.packDir(id), { recursive: true })
    const copy = this.get(id)
    copy.id = id
    copy.name = `${source.name} 副本`
    copy.createdAt = Date.now()
    this.writePack(copy)
    return this.get(id)
  }

  remove(petId: string): boolean {
    const pack = this.get(petId)
    if (pack.kind === 'builtin') throw new Error('内置桌宠不能删除')
    rmSync(this.packDir(petId), { recursive: true, force: true })
    if (this.config.get().activePetId === petId) {
      this.config.patch({ activePetId: 'builtin' })
    }
    return true
  }

  setActive(petId: string): PetPack {
    const pack = this.get(petId)
    this.config.patch({ activePetId: petId })
    return pack
  }

  location(petId: string): string {
    return this.packDir(petId)
  }

  saveAction(petId: string, action: PetAction, assets: ActionAssets): PetPack {
    const pack = this.get(petId)
    const index = pack.actions.findIndex((item) => item.id === action.id)
    const id = safeSegment(action.id || `action-${Date.now()}`)
    const next = normalizeAction({ ...action, id }, index >= 0 ? index : pack.actions.length)
    const dir = this.packDir(petId)

    if (assets.frames !== undefined) {
      const frameDir = join(dir, 'frames', id)
      rmSync(frameDir, { recursive: true, force: true })
      next.frames = []
      assets.frames.slice(0, MAX_FRAMES).forEach((dataUrl, frameIndex) => {
        const ext = this.writeDataUrlFile(frameDir, String(frameIndex), dataUrl)
        next.frames.push(`frames/${id}/${frameIndex}.${ext}`)
      })
    }

    if (assets.sound !== undefined) {
      this.deleteAsset(petId, next.sound)
      next.sound = null
      if (assets.sound) {
        const ext = this.writeDataUrlFile(join(dir, 'sounds'), id, assets.sound.dataUrl)
        next.sound = `sounds/${id}.${ext}`
      }
    }

    if (index >= 0) pack.actions[index] = next
    else pack.actions.push(next)
    this.writePack(pack)
    return this.get(petId)
  }

  deleteAction(petId: string, actionId: string): PetPack {
    const pack = this.get(petId)
    const action = pack.actions.find((item) => item.id === actionId)
    if (!action) return pack
    this.deleteAsset(petId, action.sound)
    rmSync(join(this.packDir(petId), 'frames', safeSegment(action.id)), {
      recursive: true,
      force: true
    })
    pack.actions = pack.actions.filter((item) => item.id !== actionId)
    this.writePack(pack)
    return this.get(petId)
  }

  resetActions(petId: string): PetPack {
    const pack = this.get(petId)
    pack.actions = defaultActions()
    rmSync(join(this.packDir(petId), 'frames'), { recursive: true, force: true })
    rmSync(join(this.packDir(petId), 'sounds'), { recursive: true, force: true })
    this.writePack(pack)
    return this.get(petId)
  }

  importFromDirectory(sourceDir: string): PetPack {
    const sourceJson = join(sourceDir, 'pet.json')
    if (!existsSync(sourceJson)) {
      throw new Error('这个文件夹里没有 pet.json，不是有效的桌宠包')
    }
    let raw: Partial<PetPack>
    try {
      raw = JSON.parse(readFileSync(sourceJson, 'utf8')) as Partial<PetPack>
    } catch {
      throw new Error('pet.json 不是有效的 JSON 文件')
    }
    if (raw.schema !== PET_SCHEMA) {
      throw new Error('桌宠包版本不受支持（需要 deskpet/pet@1）')
    }
    const id = randomUUID()
    const destination = this.packDir(id)
    try {
      cpSync(sourceDir, destination, { recursive: true })
      this.assertNoSymlinks(destination)
      const imported = this.get(id)
      imported.id = id
      imported.kind = 'custom'
      imported.name = safeName(raw.name, '导入的桌宠')
      imported.createdAt = Date.now()
      imported.updatedAt = Date.now()
      this.writePack(imported)
      log.info(`Imported pet "${imported.name}" (${id})`)
      return this.get(id)
    } catch (error) {
      rmSync(destination, { recursive: true, force: true })
      throw error
    }
  }

  exportToDirectory(petId: string, targetRoot: string): string {
    const pack = this.get(petId)
    const base = pack.name.replace(/[\\/:*?"<>|\r\n]/g, '_').trim() || 'deskpet'
    let folder = join(targetRoot, base)
    if (existsSync(folder)) folder = join(targetRoot, `${base}-${Date.now()}`)
    cpSync(this.packDir(petId), folder, { recursive: true })
    const jsonPath = join(folder, 'pet.json')
    const exported = JSON.parse(readFileSync(jsonPath, 'utf8')) as PetPack
    exported.kind = 'custom'
    exported.updatedAt = Date.now()
    writeFileSync(jsonPath, `${JSON.stringify(exported, null, 2)}\n`, 'utf8')
    log.info(`Exported pet ${petId} to ${folder}`)
    return folder
  }
}

function safeSegment(value: string): string {
  return /^[a-zA-Z0-9._-]+$/.test(value) && !value.includes('..') ? value : 'asset'
}

function safeName(value: unknown, fallback: string, maxLength = 40): string {
  if (typeof value !== 'string') return fallback
  const name = value.trim().replace(/[\r\n\t]/g, ' ').slice(0, maxLength)
  return name || fallback
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Math.round(Number(value))
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

interface DataUrlMatch {
  mime: string
  base64: string
}

function parseDataUrl(dataUrl: string): DataUrlMatch {
  const match = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+)(?:;charset=[^;]+)?;base64,([A-Za-z0-9+/=\s]+)$/.exec(
    dataUrl
  )
  if (!match) throw new Error('无法识别的文件数据')
  const base64 = match[2].replace(/\s+/g, '')
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.byteLength === 0) throw new Error('文件数据为空')
  if (buffer.byteLength > 25 * 1024 * 1024) throw new Error('文件太大（上限 25MB）')
  return { mime: match[1].toLowerCase(), base64 }
}

function normalizeAction(raw: Partial<PetAction>, index: number): PetAction {
  const trigger = TRIGGER_SET.has(raw.trigger as PetTrigger)
    ? (raw.trigger as PetTrigger)
    : 'custom'
  const animation = ANIMATION_SET.has(raw.animation as PetAnimation)
    ? (raw.animation as PetAnimation)
    : 'bounce'
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? safeSegment(raw.id.trim()) : `action-${index + 1}`,
    name: safeName(raw.name, `动作 ${index + 1}`),
    trigger,
    animation,
    durationMs: clampInt(raw.durationMs, 100, 15000, 700),
    frames: Array.isArray(raw.frames)
      ? raw.frames.filter((item): item is string => typeof item === 'string').slice(0, MAX_FRAMES)
      : [],
    frameDurationMs: clampInt(raw.frameDurationMs, 30, 2000, 120),
    sound: typeof raw.sound === 'string' && raw.sound ? raw.sound : null,
    say: typeof raw.say === 'string' ? raw.say.slice(0, 300) : '',
    cooldownMs: clampInt(raw.cooldownMs, 0, 3_600_000, 1000),
    enabled: raw.enabled !== false,
    emotion: typeof raw.emotion === 'string' ? raw.emotion.slice(0, 30) : undefined
  }
}
