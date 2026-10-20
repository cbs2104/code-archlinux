/**
 * Shared types between the Electron main process, the preload bridge and the
 * two renderers (pet + settings). Keep this file free of Node/DOM APIs so it
 * can be imported from both sides.
 */

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer U)[]
    ? U[]
    : T[K] extends object | undefined
      ? DeepPartial<NonNullable<T[K]>>
      : T[K]
}

export interface Point {
  x: number
  y: number
}

export interface Rect extends Point {
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

/* ------------------------------------------------------------------ input */

export type PetTrigger =
  | 'click'
  | 'double-click'
  | 'drag-start'
  | 'land'
  | 'typing'
  | 'key-enter'
  | 'key-escape'
  | 'save-hotkey'
  | 'wheel'
  | 'mouse-near'
  | 'idle'
  | 'ai-reply'
  | 'custom'

export const PET_TRIGGERS: { value: PetTrigger; label: string }[] = [
  { value: 'click', label: '单击桌宠' },
  { value: 'double-click', label: '双击桌宠' },
  { value: 'drag-start', label: '被拖动' },
  { value: 'land', label: '落地时' },
  { value: 'typing', label: '你打字时' },
  { value: 'key-enter', label: '按回车' },
  { value: 'key-escape', label: '按 Esc' },
  { value: 'save-hotkey', label: '按 Ctrl + S' },
  { value: 'wheel', label: '滚动滚轮' },
  { value: 'mouse-near', label: '鼠标靠近' },
  { value: 'idle', label: '你离开电脑' },
  { value: 'ai-reply', label: 'AI 回复时' },
  { value: 'custom', label: '仅手动 / 测试' }
]

export type PetAnimation =
  | 'none'
  | 'bounce'
  | 'jump'
  | 'spin'
  | 'shake'
  | 'nod'
  | 'wobble'
  | 'wave'
  | 'squash'
  | 'float'

export const PET_ANIMATIONS: { value: PetAnimation; label: string }[] = [
  { value: 'none', label: '无（仅换帧）' },
  { value: 'bounce', label: '蹦跳' },
  { value: 'jump', label: '跳跃' },
  { value: 'spin', label: '转圈' },
  { value: 'shake', label: '摇头' },
  { value: 'nod', label: '点头' },
  { value: 'wobble', label: '晃动' },
  { value: 'wave', label: '挥手' },
  { value: 'squash', label: '压扁回弹' },
  { value: 'float', label: '漂浮' }
]

export type InputKind =
  | 'typing'
  | 'click'
  | 'wheel'
  | 'enter'
  | 'escape'
  | 'save'
  | 'idle'
  | 'wake'

export interface InputEvent {
  kind: InputKind
  /** number of keystrokes folded into this event */
  count?: number
  detail?: string
  at: number
}

export interface CursorInfo {
  /** cursor position in the pet window's CSS pixels */
  x: number
  y: number
  /** cursor position on the virtual desktop (DIP) */
  screenX: number
  screenY: number
  inside: boolean
}

/* -------------------------------------------------------------- pet packs */

export const PET_SCHEMA = 'deskpet/pet@1' as const

export interface PetAction {
  id: string
  name: string
  trigger: PetTrigger
  animation: PetAnimation
  durationMs: number
  /** asset paths relative to the pack folder, e.g. frames/wave/0.png */
  frames: string[]
  frameDurationMs: number
  /** asset path relative to the pack folder */
  sound: string | null
  say: string
  cooldownMs: number
  enabled: boolean
  /** optional emotion marker used by the AI reply animation */
  emotion?: string
}

export interface PetSprite {
  kind: 'builtin' | 'image'
  /** asset path relative to the pack folder (only for kind === 'image') */
  asset: string | null
  width: number
  height: number
}

export interface PetPack {
  schema: typeof PET_SCHEMA
  id: string
  name: string
  author: string
  version: string
  kind: 'builtin' | 'custom'
  createdAt: number
  updatedAt: number
  sprite: PetSprite
  actions: PetAction[]
  greeting: string
}

/* ------------------------------------------------------------------ config */

export interface PetSettings {
  scale: number
  opacity: number
  alwaysOnTop: boolean
  showOnAllWorkspaces: boolean
  roaming: boolean
  roamSpeed: number
  clickThrough: boolean
}

export interface WindowSettings {
  x: number | null
  y: number | null
}

export interface ReactionSettings {
  lookAtCursor: boolean
  typing: boolean
  mouseClick: boolean
  wheel: boolean
  hotkeys: boolean
  mouseNear: boolean
  idleSleepMinutes: number
}

export interface InteractionSettings {
  inputMonitor: boolean
  reactions: ReactionSettings
}

export interface VoiceSettings {
  enabled: boolean
  voiceUri: string
  language: string
  rate: number
  pitch: number
  volume: number
  speakReplies: boolean
  speakActionLines: boolean
  sfxVolume: number
}

export interface AiSettings {
  enabled: boolean
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
  systemPrompt: string
  streaming: boolean
  sttEnabled: boolean
  sttModel: string
  historyLimit: number
}

export interface HotkeySettings {
  togglePet: string
  openChat: string
}

export interface AppConfig {
  version: number
  activePetId: string
  savePosition: boolean
  pet: PetSettings
  window: WindowSettings
  interaction: InteractionSettings
  voice: VoiceSettings
  ai: AiSettings
  hotkeys: HotkeySettings
  launchAtLogin: boolean
}

/* ------------------------------------------------------------------ system */

export interface AppInfo {
  appVersion: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  userData: string
  petsDir: string
  configFile: string
  logFile: string
  packaged: boolean
}

export interface InputStatus {
  available: boolean
  running: boolean
  error: string | null
  platform: string
  sessionType: string
  accessibilityTrusted: boolean
}

export interface HotkeyStatus {
  entries: { name: string; accelerator: string; ok: boolean }[]
}

export interface PetEnv {
  workArea: Rect
  bounds: Rect
  windowSize: Size
  scaleFactor: number
  chatOpen: boolean
  visible: boolean
}

export interface DialogImage {
  name: string
  path: string
  dataUrl: string
  width: number
  height: number
}

export interface AudioAsset {
  name: string
  path: string
  dataUrl: string
  ext: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatHistoryEntry {
  role: 'user' | 'assistant'
  content: string
  at: number
}

export interface SpriteInput {
  name: string
  dataUrl: string
  width: number
  height: number
  sourceName?: string
}

export interface ActionAssets {
  /** new frame images as data URLs (PNG/JPEG/WebP) */
  frames?: string[]
  /** new sound as a data URL */
  sound?: { dataUrl: string; name: string } | null
}

export interface TestActionPayload {
  action: PetAction
  frames: string[]
  sound: string | null
}

export type PetCommand =
  | 'say-hello'
  | 'open-chat'
  | 'open-settings'
  | 'hide'
  | 'reset-position'
  | 'wake'
  | 'wave'

export interface AiChatRequest {
  requestId: string
  messages: ChatMessage[]
}

export interface AiChunkEvent {
  requestId: string
  delta: string
}

export interface AiDoneEvent {
  requestId: string
  text: string
}

export interface AiErrorEvent {
  requestId: string
  message: string
}

export interface AiTestResult {
  ok: boolean
  message: string
}

export type SettingsTab =
  | 'pet'
  | 'studio'
  | 'actions'
  | 'voice'
  | 'interaction'
  | 'ai'
  | 'about'

/* -------------------------------------------------------------- preload API */

export interface DeskPetApi {
  app: {
    info(): Promise<AppInfo>
    platform: string
    quit(): void
    openExternal(url: string): Promise<void>
    showItemInFolder(path: string): Promise<void>
    openPath(path: string): Promise<void>
    relaunch(): void
  }
  config: {
    get(): Promise<AppConfig>
    patch(patch: DeepPartial<AppConfig>): Promise<AppConfig>
    reset(): Promise<AppConfig>
    onChange(cb: (config: AppConfig) => void): () => void
  }
  pets: {
    list(): Promise<PetPack[]>
    get(id: string): Promise<PetPack>
    createFromSprite(input: SpriteInput): Promise<PetPack>
    replaceSprite(petId: string, input: Omit<SpriteInput, 'name'>): Promise<PetPack>
    rename(petId: string, name: string): Promise<PetPack>
    duplicate(petId: string): Promise<PetPack>
    remove(petId: string): Promise<boolean>
    setActive(petId: string): Promise<PetPack>
    saveAction(petId: string, action: PetAction, assets: ActionAssets): Promise<PetPack>
    deleteAction(petId: string, actionId: string): Promise<PetPack>
    resetActions(petId: string): Promise<PetPack>
    importPack(): Promise<PetPack | null>
    exportPack(petId: string): Promise<string | null>
    setGreeting(petId: string, greeting: string): Promise<PetPack>
    onChange(cb: (pets: PetPack[]) => void): () => void
  }
  dialogs: {
    openImage(): Promise<DialogImage | null>
    openImages(): Promise<DialogImage[]>
    openAudio(): Promise<AudioAsset | null>
    openDirectory(): Promise<string | null>
  }
  pet: {
    getEnv(): Promise<PetEnv>
    moveTo(x: number, y: number): void
    setHitbox(rect: Rect | null): void
    setChatOpen(open: boolean): Promise<PetEnv>
    beginDrag(): void
    endDrag(): void
    setInteractive(interactive: boolean): void
    contextMenu(): void
    openSettings(tab?: SettingsTab): void
    openChat(): void
    hide(): void
    toggle(): Promise<boolean>
    resetPosition(): Promise<PetEnv>
    testAction(payload: TestActionPayload): void
    onCursor(cb: (info: CursorInfo) => void): () => void
    onInput(cb: (event: InputEvent) => void): () => void
    onEnv(cb: (env: PetEnv) => void): () => void
    onCommand(cb: (command: PetCommand) => void): () => void
    onTestAction(cb: (payload: TestActionPayload) => void): () => void
    onContextMenu(cb: () => void): () => void
  }
  ai: {
    chat(req: AiChatRequest): void
    cancel(requestId: string): void
    test(): Promise<AiTestResult>
    transcribe(data: ArrayBuffer, mime: string): Promise<string>
    onChunk(cb: (event: AiChunkEvent) => void): () => void
    onDone(cb: (event: AiDoneEvent) => void): () => void
    onError(cb: (event: AiErrorEvent) => void): () => void
  }
  history: {
    load(): Promise<ChatHistoryEntry[]>
    save(entries: ChatHistoryEntry[]): Promise<void>
    clear(): Promise<void>
  }
  system: {
    inputStatus(): Promise<InputStatus>
    restartInput(): Promise<InputStatus>
    hotkeyStatus(): Promise<HotkeyStatus>
    autostart: {
      get(): Promise<boolean>
      set(enabled: boolean): Promise<boolean>
    }
    setAlwaysOnTop(enabled: boolean): Promise<void>
  }
  settings: {
    onTab(cb: (tab: SettingsTab) => void): () => void
    onRequestClose(cb: () => void): () => void
  }
}

/* ----------------------------------------------------------------- presets */

export interface AiPreset {
  id: string
  label: string
  baseUrl: string
  model: string
  hint: string
}

export const AI_PRESETS: AiPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    hint: '官方 API，支持流式回复与语音识别'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    hint: '兼容 OpenAI 协议，价格便宜'
  },
  {
    id: 'moonshot',
    label: 'Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    hint: '月之暗面 Kimi 的兼容接口'
  },
  {
    id: 'dashscope',
    label: '阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    hint: '通义千问 OpenAI 兼容模式'
  },
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    hint: '本地模型，无需 API Key；需先 ollama serve'
  },
  {
    id: 'lmstudio',
    label: 'LM Studio（本地）',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'local-model',
    hint: 'LM Studio 开启本地服务器后使用'
  },
  {
    id: 'custom',
    label: '自定义 / 其他兼容接口',
    baseUrl: '',
    model: '',
    hint: '任何兼容 /chat/completions 的服务'
  }
]
