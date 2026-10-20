import { petAssetUrl } from '../../shared/defaults'
import type { AppConfig, PetEnv, PetPack, Rect } from '../../shared/types'
import { builtinPetSvg } from './builtin'
import { ChatPanel } from './chat'
import { PetEngine } from './engine'
import { Speaker } from './speech'

const api = window.deskpet

const stage = document.getElementById('stage') as HTMLElement
const sprite = document.getElementById('sprite') as HTMLElement
const baseHost = document.getElementById('pet-base') as HTMLElement
const frameLayer = document.getElementById('pet-frame') as HTMLImageElement
const spriteWrap = document.getElementById('sprite-wrap') as HTMLElement
const bubble = document.getElementById('bubble') as HTMLElement
const bubbleText = document.getElementById('bubble-text') as HTMLElement
const zzz = document.getElementById('zzz') as HTMLElement

let config: AppConfig
let packs: PetPack[] = []
let pack: PetPack
let env: PetEnv
let speaker: Speaker
let engine: PetEngine
let chat: ChatPanel
let hovering = false
let press: { pointerId: number; x: number; y: number; moved: boolean } | null = null
let lastClickAt = 0
let greeted = false

function updateHitbox(): void {
  if (!spriteWrap) return
  const rect = spriteWrap.getBoundingClientRect()
  let left = rect.left
  let top = rect.top
  let right = rect.right
  let bottom = rect.bottom
  if (!bubble.classList.contains('hidden')) {
    const bubbleRect = bubble.getBoundingClientRect()
    if (bubbleRect.width > 0) {
      left = Math.min(left, bubbleRect.left)
      top = Math.min(top, bubbleRect.top)
      right = Math.max(right, bubbleRect.right)
      bottom = Math.max(bottom, bubbleRect.bottom)
    }
  }
  const pad = 6
  const hit: Rect = {
    x: Math.floor(left - pad),
    y: Math.floor(top - pad),
    width: Math.ceil(right - left + pad * 2),
    height: Math.ceil(bottom - top + pad * 2)
  }
  api.pet.setHitbox(hit)
}

function setHovering(value: boolean): void {
  if (hovering === value) return
  hovering = value
  api.pet.setInteractive(value)
}

function renderSprite(): void {
  baseHost.replaceChildren()
  baseHost.classList.remove('frames-active')
  frameLayer.hidden = true
  frameLayer.removeAttribute('src')
  sprite.classList.remove('frames-active', 'wave', 'blink')
  if (pack.sprite.kind === 'image' && pack.sprite.asset) {
    const image = document.createElement('img')
    image.className = 'pet-image'
    image.alt = pack.name
    image.draggable = false
    image.src = `${petAssetUrl(pack.id, pack.sprite.asset)}?v=${pack.updatedAt}`
    image.addEventListener('load', () => updateHitbox())
    image.addEventListener('error', () => {
      baseHost.replaceChildren()
      baseHost.innerHTML = builtinPetSvg()
      updateHitbox()
    })
    baseHost.append(image)
  } else {
    baseHost.innerHTML = builtinPetSvg()
  }
  document.documentElement.style.setProperty('--pet-scale', String(config.pet.scale))
  sprite.style.opacity = String(config.pet.opacity)
  updateHitbox()
}

async function reloadPack(petId: string, announce = true): Promise<void> {
  try {
    const next = await api.pets.get(petId)
    if (pack && next.id === pack.id && next.updatedAt === pack.updatedAt) return
    pack = next
    renderSprite()
    engine.setPack(pack)
    engine.setMood('happy', 1800)
    chat.updateHeader()
    if (announce && !chat.isOpen()) {
      speaker.say(pack.greeting || `我是${pack.name}，请多关照！`, {
        speak: config.voice.enabled && config.voice.speakReplies
      })
    }
  } catch {
    /* keep the current pet if the new one cannot be loaded */
  }
}

function applyConfig(next: AppConfig): void {
  config = next
  document.documentElement.style.setProperty('--pet-scale', String(config.pet.scale))
  sprite.style.opacity = String(config.pet.opacity)
  engine?.setConfig(config)
  engine?.setChatOpen(chat?.isOpen() ?? false)
  chat?.updateHeader()
  if (pack && next.activePetId !== pack.id) {
    void reloadPack(next.activePetId)
  }
  updateHitbox()
}

async function boot(): Promise<void> {
  config = await api.config.get()
  packs = await api.pets.list()
  const stored = packs.find((item) => item.id === config.activePetId)
  pack = stored ?? packs[0]
  if (!pack) throw new Error('没有可用的桌宠数据')
  env = await api.pet.getEnv()

  speaker = new Speaker(() => config, bubble, bubbleText)
  speaker.setOnBubbleToggle(() => updateHitbox())
  engine = new PetEngine({
    api,
    getConfig: () => config,
    getPack: () => pack,
    sprite,
    baseHost,
    frameLayer,
    resolveAsset: (relativePath) => `${petAssetUrl(pack.id, relativePath)}?v=${pack.updatedAt}`,
    env,
    hooks: {
      say: (text, speak) => {
        speaker.say(text, {
          speak: Boolean(speak && config.voice.enabled && config.voice.speakActionLines)
        })
        updateHitbox()
      },
      playSound: (src) => speaker.playSound(src),
      onMood: (mood) => {
        sprite.dataset.mood = mood
      },
      onSleep: (sleeping) => {
        zzz.classList.toggle('hidden', !sleeping)
        if (sleeping) speaker.hideBubble()
      }
    }
  })

  chat = new ChatPanel({
    api,
    getConfig: () => config,
    getPack: () => pack,
    onOpenChange: (open) => {
      if (open) {
        speaker.hideBubble()
        speaker.stopSpeaking()
        engine.handleInput({ kind: 'wake', at: Date.now() })
      }
      updateHitbox()
    },
    setMood: (mood) => engine.setMood(mood, 5000),
    playTrigger: (trigger) => {
      engine.playTrigger(trigger)
    },
    speakReply: (text) => speaker.speak(text)
  })

  wireEvents()
  renderSprite()
  engine.start()
  applyConfig(config)
  window.setTimeout(() => void maybeGreet(), 900)
}

async function maybeGreet(): Promise<void> {
  if (greeted) return
  greeted = true
  try {
    env = await api.pet.getEnv()
  } catch {
    greeted = false
    return
  }
  if (!env.visible) {
    greeted = false
    return
  }
  speaker.say(pack.greeting || '我来啦！', {
    speak: config.voice.enabled && config.voice.speakReplies
  })
  engine.setMood('happy', 2500)
}

function handlePetClick(): void {
  const now = Date.now()
  const isDouble = now - lastClickAt < 300
  lastClickAt = isDouble ? 0 : now
  if (isDouble) engine.playTrigger('double-click')
  else engine.playTrigger('click')
}

function wireEvents(): void {
  stage.addEventListener('pointerenter', () => setHovering(true))
  stage.addEventListener('pointerleave', () => {
    setHovering(false)
    if (press) {
      press = null
      engine.endDrag()
    }
  })

  spriteWrap.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    setHovering(true)
    press = {
      pointerId: event.pointerId,
      x: event.screenX,
      y: event.screenY,
      moved: false
    }
    try {
      spriteWrap.setPointerCapture(event.pointerId)
    } catch {
      /* ignore */
    }
    engine.beginDrag(event.screenX, event.screenY)
  })

  spriteWrap.addEventListener('pointermove', (event) => {
    if (!press || event.pointerId !== press.pointerId) return
    if (Math.hypot(event.screenX - press.x, event.screenY - press.y) > 4) press.moved = true
    engine.dragMove(event.screenX, event.screenY)
  })

  const finishPointer = (event: PointerEvent): void => {
    if (!press || event.pointerId !== press.pointerId) return
    const moved = press.moved
    const pointerId = press.pointerId
    press = null
    try {
      spriteWrap.releasePointerCapture(pointerId)
    } catch {
      /* ignore */
    }
    engine.endDrag()
    if (!moved) handlePetClick()
  }
  spriteWrap.addEventListener('pointerup', finishPointer)
  spriteWrap.addEventListener('pointercancel', finishPointer)

  stage.addEventListener('contextmenu', (event) => {
    const target = event.target as HTMLElement | null
    if (target?.closest('#chat')) return
    event.preventDefault()
    api.pet.contextMenu()
  })

  const bubbleClose = document.getElementById('bubble-close')
  bubbleClose?.addEventListener('click', () => speaker.hideBubble())
  bubble.addEventListener('click', () => speaker.hideBubble())

  window.addEventListener('resize', () => updateHitbox())
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && chat.isOpen()) {
      event.preventDefault()
      void chat.closePanel()
    }
  })
  window.addEventListener('beforeunload', () => {
    engine.stop()
    speaker.stopSpeaking()
    speaker.stopSound()
  })

  api.pet.onCursor((info) => {
    engine.setCursor(info)
    if (chat.isOpen()) {
      setHovering(false)
      return
    }
    setHovering(info.inside)
  })

  api.pet.onInput((event) => {
    engine.handleInput(event)
  })

  api.pet.onEnv((next) => {
    env = next
    engine.setEnv(next)
    updateHitbox()
    if (next.visible) void maybeGreet()
  })

  api.config.onChange((next) => {
    applyConfig(next)
  })

  api.pets.onChange((next) => {
    packs = next
    const active = packs.find((item) => item.id === config.activePetId)
    if (!active) return
    if (active.updatedAt !== pack.updatedAt || active.sprite.asset !== pack.sprite.asset) {
      void reloadPack(active.id, false)
    }
  })

  api.pet.onCommand((command) => {
    switch (command) {
      case 'say-hello':
        engine.playTrigger('click')
        speaker.say(pack.greeting || '你好呀！', {
          speak: config.voice.enabled && config.voice.speakActionLines
        })
        break
      case 'open-chat':
        void chat.openPanel()
        break
      case 'hide':
        api.pet.hide()
        break
      case 'wake':
        engine.handleInput({ kind: 'wake', at: Date.now() })
        void maybeGreet()
        break
      case 'wave':
        engine.playTrigger('mouse-near')
        engine.setMood('happy', 2200)
        break
      case 'open-settings':
        api.pet.openSettings('pet')
        break
      default:
        break
    }
  })

  api.pet.onTestAction((payload) => {
    engine.playTest(payload)
  })
}

boot().catch((error) => {
  console.error('DeskPet pet failed to start', error)
  bubble.classList.remove('hidden', 'bubble-hidden')
  bubble.classList.add('bubble-show')
  bubbleText.textContent = `桌宠启动失败：${(error as Error).message}`
  zzz.classList.add('hidden')
})
