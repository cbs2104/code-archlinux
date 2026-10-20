import type { AppConfig, PetAction, PetPack } from './types'
import { PET_SCHEMA } from './types'

export const CONFIG_VERSION = 3

/** Default (and minimum) pet window size in CSS pixels. */
export const PET_WINDOW = { width: 360, height: 380 }
/** Window size while the chat panel is open. */
export const CHAT_WINDOW = { width: 420, height: 660 }

export const DEFAULT_SYSTEM_PROMPT = [
  '你是用户桌面上的小桌宠，名字叫「小奶糕」。',
  '你是一只圆滚滚、好奇、温柔又有点黏人的小生物，说话口语化、简短（通常 1-3 句），偶尔用「喵」结尾，但不要每句都用。',
  '你住在用户的屏幕上，能感知用户正在打字、点击鼠标或离开电脑，可以自然地提到这些事。',
  '不要编造你无法知道的事实；用户问你问题时认真回答，必要时给出清晰的步骤。',
  '回答使用简体中文（用户使用其他语言时跟随用户）。',
  '如果情绪明显，可以在回复最后附上一个情绪标记：[[happy]]、[[sad]]、[[think]]、[[sleepy]]、[[love]]，最多一个，标记本身不会被用户看到。'
].join('\n')

export const DEFAULT_CONFIG: AppConfig = {
  version: CONFIG_VERSION,
  activePetId: 'builtin',
  savePosition: true,
  pet: {
    scale: 1,
    opacity: 1,
    alwaysOnTop: true,
    showOnAllWorkspaces: true,
    roaming: true,
    roamSpeed: 55,
    clickThrough: false
  },
  window: {
    x: null,
    y: null
  },
  interaction: {
    inputMonitor: true,
    reactions: {
      lookAtCursor: true,
      typing: true,
      mouseClick: true,
      wheel: true,
      hotkeys: true,
      mouseNear: true,
      idleSleepMinutes: 5
    }
  },
  voice: {
    enabled: true,
    voiceUri: '',
    language: 'zh-CN',
    rate: 1,
    pitch: 1.05,
    volume: 0.9,
    speakReplies: true,
    speakActionLines: true,
    sfxVolume: 0.8
  },
  ai: {
    enabled: false,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.8,
    maxTokens: 400,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    streaming: true,
    sttEnabled: false,
    sttModel: 'whisper-1',
    historyLimit: 12
  },
  hotkeys: {
    togglePet: 'CommandOrControl+Alt+Shift+P',
    openChat: 'CommandOrControl+Alt+Shift+K'
  },
  launchAtLogin: false
}

const ACTIONS: PetAction[] = [
  {
    id: 'hello',
    name: '打招呼',
    trigger: 'click',
    animation: 'bounce',
    durationMs: 800,
    frames: [],
    frameDurationMs: 120,
    sound: null,
    say: '喵～',
    cooldownMs: 600,
    enabled: true,
    emotion: 'happy'
  },
  {
    id: 'poke',
    name: '被戳烦了',
    trigger: 'double-click',
    animation: 'spin',
    durationMs: 900,
    frames: [],
    frameDurationMs: 120,
    sound: null,
    say: '别戳啦，会晕的！',
    cooldownMs: 800,
    enabled: true
  },
  {
    id: 'grabbed',
    name: '被拎起来',
    trigger: 'drag-start',
    animation: 'squash',
    durationMs: 700,
    frames: [],
    frameDurationMs: 120,
    sound: null,
    say: '哇啊啊——轻点轻点！',
    cooldownMs: 1500,
    enabled: true
  },
  {
    id: 'landed',
    name: '落地',
    trigger: 'land',
    animation: 'squash',
    durationMs: 500,
    frames: [],
    frameDurationMs: 100,
    sound: null,
    say: '咚。',
    cooldownMs: 1200,
    enabled: false
  },
  {
    id: 'typing',
    name: '陪你打字',
    trigger: 'typing',
    animation: 'nod',
    durationMs: 600,
    frames: [],
    frameDurationMs: 120,
    sound: null,
    say: '在忙呀？我在这儿陪着你。',
    cooldownMs: 180000,
    enabled: true
  },
  {
    id: 'enter',
    name: '回车活力',
    trigger: 'key-enter',
    animation: 'nod',
    durationMs: 400,
    frames: [],
    frameDurationMs: 100,
    sound: null,
    say: '',
    cooldownMs: 4000,
    enabled: true
  },
  {
    id: 'escape',
    name: '被 Esc 吓到',
    trigger: 'key-escape',
    animation: 'shake',
    durationMs: 600,
    frames: [],
    frameDurationMs: 100,
    sound: null,
    say: '要逃跑吗？',
    cooldownMs: 8000,
    enabled: true
  },
  {
    id: 'save',
    name: '保存成功',
    trigger: 'save-hotkey',
    animation: 'bounce',
    durationMs: 700,
    frames: [],
    frameDurationMs: 100,
    sound: null,
    say: '保存好啦！',
    cooldownMs: 3000,
    enabled: true
  },
  {
    id: 'scroll',
    name: '滚轮晃动',
    trigger: 'wheel',
    animation: 'wobble',
    durationMs: 500,
    frames: [],
    frameDurationMs: 100,
    sound: null,
    say: '',
    cooldownMs: 2500,
    enabled: true
  },
  {
    id: 'near',
    name: '鼠标靠近',
    trigger: 'mouse-near',
    animation: 'wave',
    durationMs: 900,
    frames: [],
    frameDurationMs: 120,
    sound: null,
    say: '嗨，我在这儿！',
    cooldownMs: 90000,
    enabled: true
  },
  {
    id: 'away',
    name: '你离开了',
    trigger: 'idle',
    animation: 'float',
    durationMs: 1000,
    frames: [],
    frameDurationMs: 120,
    sound: null,
    say: '去休息一下吧，我帮你看家～',
    cooldownMs: 600000,
    enabled: true
  },
  {
    id: 'ai-happy',
    name: 'AI 开心',
    trigger: 'ai-reply',
    animation: 'bounce',
    durationMs: 700,
    frames: [],
    frameDurationMs: 100,
    sound: null,
    say: '',
    cooldownMs: 1500,
    enabled: true,
    emotion: 'happy'
  }
]

export function defaultActions(): PetAction[] {
  return clone(ACTIONS)
}

export function createBuiltinPack(): PetPack {
  const now = Date.now()
  return {
    schema: PET_SCHEMA,
    id: 'builtin',
    name: '小奶糕',
    author: 'DeskPet',
    version: '1.0.0',
    kind: 'builtin',
    createdAt: now,
    updatedAt: now,
    sprite: {
      kind: 'builtin',
      asset: null,
      width: 200,
      height: 200
    },
    actions: defaultActions(),
    greeting: '我回来啦！'
  }
}

/** Deep merge used for config patches; arrays are replaced, not merged. */
export function mergeDeep<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base
  if (Array.isArray(base) || Array.isArray(patch)) return clone(patch) as T
  if (typeof base !== 'object' || base === null || typeof patch !== 'object') {
    return patch as T
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    out[key] = key in out ? mergeDeep(out[key], value) : clone(value)
  }
  return out as T
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function randBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

/** Build a URL that the main process serves from userData/pets/<id>/. */
export function petAssetUrl(petId: string, relativePath: string): string {
  const safePath = relativePath
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
  return `deskpet://assets/${encodeURIComponent(petId)}/${safePath}`
}
