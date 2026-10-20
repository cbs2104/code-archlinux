import { clamp, randBetween } from '../../shared/defaults'
import type {
  AppConfig,
  CursorInfo,
  InputEvent,
  PetAction,
  PetEnv,
  PetPack,
  PetTrigger,
  TestActionPayload
} from '../../shared/types'
import { setMood as applyBuiltinMood, setPupilOffset, type PetMood } from './builtin'

type EngineState = 'idle' | 'walk' | 'drag' | 'land' | 'sleep'

interface ActiveAction {
  action: PetAction
  start: number
  endAt: number
  animDuration: number
  frames: string[]
  frameDuration: number
}

export interface EngineHooks {
  say: (text: string, speak?: boolean) => void
  playSound: (src: string, volume?: number) => void
  onMood: (mood: PetMood) => void
  onSleep: (sleeping: boolean) => void
}

export interface EngineOptions {
  api: Window['deskpet']
  getConfig: () => AppConfig
  getPack: () => PetPack
  sprite: HTMLElement
  baseHost: HTMLElement
  frameLayer: HTMLImageElement
  resolveAsset: (relativePath: string) => string
  hooks: EngineHooks
  env: PetEnv
}

const DRAG_REST_MS = 60_000

export class PetEngine {
  private state: EngineState = 'idle'
  private pos: { x: number; y: number }
  private dragStart = { pointerX: 0, pointerY: 0, windowX: 0, windowY: 0 }
  private dragMoved = false
  private dragging = false
  private env: PetEnv
  private facing: 1 | -1 = 1
  private targetX = 0
  private nextWanderAt = 0
  private restUntil = 0
  private sleeping = false
  private chatOpen = false
  private mood: PetMood = 'neutral'
  private moodUntil = 0
  private currentAction: ActiveAction | null = null
  private cooldowns = new Map<string, number>()
  private blinkUntil = 0
  private nextBlinkAt = 0
  private landUntil = 0
  private pulseUntil = 0
  private pulseKind: 'click' | null = null
  private cursor: CursorInfo | null = null
  private wasNear = false
  private wasInside = false
  private lastFrameSrc = ''
  private raf = 0
  private lastTick = 0
  private lastPush = 0
  private lastSentPosition = { x: Number.NaN, y: Number.NaN }
  private startedAt = performance.now()
  private disposed = false

  constructor(private readonly options: EngineOptions) {
    this.env = options.env
    this.pos = { x: options.env.bounds.x, y: options.env.bounds.y }
    this.targetX = this.pos.x
    this.nextWanderAt = performance.now() + randBetween(5000, 10000)
    this.nextBlinkAt = performance.now() + randBetween(2500, 6000)
  }

  start(): void {
    if (this.raf) return
    this.lastTick = performance.now()
    const tick = (now: number): void => {
      if (this.disposed) return
      const dt = Math.min(0.05, Math.max(0, (now - this.lastTick) / 1000))
      this.lastTick = now
      this.update(dt, now)
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  stop(): void {
    this.disposed = true
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  setConfig(_config: AppConfig): void {
    this.nextWanderAt = Math.max(
      this.restUntil,
      performance.now() + randBetween(3000, 8000)
    )
  }

  setPack(_pack: PetPack): void {
    this.cooldowns.clear()
    this.currentAction = null
    this.options.frameLayer.hidden = true
    this.options.sprite.classList.remove('frames-active')
    this.setMood('neutral', 0)
    this.state = 'idle'
  }

  setEnv(env: PetEnv): void {
    const wasChatOpen = this.chatOpen
    this.env = env
    this.chatOpen = env.chatOpen
    this.pos = { x: env.bounds.x, y: env.bounds.y }
    if (this.state !== 'drag') {
      this.state = this.state === 'walk' ? 'idle' : this.state
      this.targetX = this.pos.x
      this.nextWanderAt = Math.max(
        this.restUntil,
        performance.now() + randBetween(4000, 9000)
      )
    }
    if (wasChatOpen && !env.chatOpen) {
      this.nextWanderAt = Math.max(this.nextWanderAt, this.restUntil)
    }
    this.pushPosition(true)
  }

  setCursor(info: CursorInfo): void {
    this.cursor = info
    if (info.inside && !this.wasInside && !this.dragging && !this.chatOpen) {
      // Do not wander out from under the user's pointer while they aim at it.
      if (this.state === 'walk') this.state = 'idle'
      this.targetX = this.pos.x
      this.nextWanderAt = Math.max(
        this.restUntil,
        performance.now() + 9000
      )
    }
    this.wasInside = info.inside
    const cfg = this.options.getConfig()
    if (!cfg.interaction.reactions.mouseNear || this.dragging) {
      this.wasNear = false
      return
    }
    const centerX = this.pos.x + this.env.windowSize.width / 2
    const centerY = this.pos.y + this.env.windowSize.height - 110 * cfg.pet.scale
    const distance = Math.hypot(info.screenX - centerX, info.screenY - centerY)
    const near = distance < 170
    if (near && !this.wasNear && !this.chatOpen && !this.sleeping) {
      this.playTrigger('mouse-near')
    }
    this.wasNear = distance < 210
  }

  handleInput(event: InputEvent): void {
    if (event.kind === 'idle') {
      this.enterSleep()
      return
    }
    if (event.kind === 'wake') {
      this.wake()
      return
    }
    this.wake()
    if (this.chatOpen) return
    const cfg = this.options.getConfig()
    const reactions = cfg.interaction.reactions
    switch (event.kind) {
      case 'typing':
        if (reactions.typing) this.playTrigger('typing')
        break
      case 'click':
        if (reactions.mouseClick) {
          this.pulseKind = 'click'
          this.pulseUntil = performance.now() + 420
          this.lookTowardCursor()
        }
        break
      case 'wheel':
        if (reactions.wheel) this.playTrigger('wheel')
        break
      case 'enter':
        if (reactions.hotkeys) this.playTrigger('key-enter')
        break
      case 'escape':
        if (reactions.hotkeys) this.playTrigger('key-escape')
        break
      case 'save':
        if (reactions.hotkeys) this.playTrigger('save-hotkey')
        break
      default:
        break
    }
  }

  setChatOpen(open: boolean): void {
    this.chatOpen = open
    if (open) {
      this.state = this.state === 'walk' || this.state === 'land' ? 'idle' : this.state
      this.nextWanderAt = Infinity
    } else {
      this.nextWanderAt = Math.max(
        this.restUntil,
        performance.now() + randBetween(5000, 10000)
      )
    }
  }

  setMood(mood: PetMood, holdMs = 3200): void {
    this.mood = mood
    this.moodUntil = holdMs > 0 ? performance.now() + holdMs : 0
    const pack = this.options.getPack()
    if (pack.sprite.kind === 'builtin') applyBuiltinMood(this.options.baseHost, mood)
    this.options.hooks.onMood(mood)
  }

  say(text: string, speak = false): void {
    if (!text) return
    this.options.hooks.say(text, speak)
  }

  playTrigger(trigger: PetTrigger): boolean {
    const pack = this.options.getPack()
    const candidates = pack.actions.filter((action) => action.enabled && action.trigger === trigger)
    if (candidates.length === 0) return false
    const now = performance.now()
    const ready = candidates.filter((action) => now >= (this.cooldowns.get(action.id) ?? 0))
    if (ready.length === 0) return false
    const action = ready[Math.floor(Math.random() * ready.length)]
    return this.playAction(action)
  }

  playAction(
    action: PetAction,
    extra?: { frames?: string[]; sound?: string | null },
    bypassCooldown = false
  ): boolean {
    if (!action) return false
    const now = performance.now()
    const cooldownUntil = this.cooldowns.get(action.id) ?? 0
    if (!bypassCooldown && now < cooldownUntil) return false
    if (!bypassCooldown) this.cooldowns.set(action.id, now + Math.max(0, action.cooldownMs))
    const frames = (extra?.frames?.length ? extra.frames : action.frames)
      .map((item) =>
        item.startsWith('data:') || item.startsWith('blob:') ? item : this.options.resolveAsset(item)
      )
      .filter(Boolean)
    const animDuration = Math.max(120, action.durationMs)
    const frameTotal = frames.length * Math.max(30, action.frameDurationMs)
    const endAt = now + Math.max(animDuration, frameTotal)
    this.currentAction = {
      action,
      start: now,
      endAt,
      animDuration,
      frames,
      frameDuration: Math.max(30, action.frameDurationMs)
    }
    this.lastFrameSrc = ''
    if (action.animation === 'wave') this.options.sprite.classList.add('wave')
    const soundSrc =
      extra && Object.prototype.hasOwnProperty.call(extra, 'sound') ? extra.sound : action.sound
    if (soundSrc) {
      const sound = soundSrc.startsWith('data:') || soundSrc.startsWith('blob:')
        ? soundSrc
        : this.options.resolveAsset(soundSrc)
      if (sound) this.options.hooks.playSound(sound)
    }
    if (action.say && !this.chatOpen) this.say(action.say, true)
    if (action.emotion) {
      const mood = action.emotion as PetMood
      if (['happy', 'sad', 'think', 'sleepy', 'love'].includes(mood)) {
        this.setMood(mood, endAt - now + 1600)
      }
    }
    return true
  }

  playTest(payload: TestActionPayload): void {
    this.playAction(
      payload.action,
      {
        frames: payload.frames,
        sound: payload.sound
      },
      true
    )
  }

  beginDrag(pointerX: number, pointerY: number): void {
    this.wake()
    this.dragging = true
    this.dragMoved = false
    this.state = 'drag'
    this.dragStart = {
      pointerX,
      pointerY,
      windowX: this.pos.x,
      windowY: this.pos.y
    }
    this.options.api.pet.beginDrag()
  }

  dragMove(pointerX: number, pointerY: number): void {
    if (!this.dragging) return
    const dx = pointerX - this.dragStart.pointerX
    const dy = pointerY - this.dragStart.pointerY
    if (!this.dragMoved && Math.hypot(dx, dy) > 4) {
      this.dragMoved = true
      this.playTrigger('drag-start')
    }
    if (Math.abs(dx) > 4) this.facing = dx < 0 ? -1 : 1
    this.pos.x = this.dragStart.windowX + dx
    this.pos.y = this.dragStart.windowY + dy
    this.clampPosition()
    this.pushPosition(true)
  }

  endDrag(): { moved: boolean } {
    if (!this.dragging) return { moved: false }
    this.dragging = false
    this.options.api.pet.endDrag()
    const moved = this.dragMoved
    this.state = moved ? 'land' : 'idle'
    if (moved) {
      this.restUntil = performance.now() + DRAG_REST_MS
      this.nextWanderAt = this.restUntil
      this.land()
    } else {
      this.nextWanderAt = Math.max(
        this.restUntil,
        performance.now() + randBetween(4000, 9000)
      )
    }
    this.pushPosition(true)
    return { moved }
  }

  private enterSleep(): void {
    if (this.chatOpen || this.dragging) return
    if (this.sleeping) return
    this.sleeping = true
    this.state = 'sleep'
    this.nextWanderAt = Infinity
    this.setMood('sleepy', 0)
    this.options.hooks.onSleep(true)
    this.playTrigger('idle')
  }

  private wake(): void {
    if (!this.sleeping) return
    this.sleeping = false
    this.state = 'idle'
    this.setMood('neutral', 0)
    this.options.hooks.onSleep(false)
    this.nextWanderAt = Math.max(
      this.restUntil,
      performance.now() + randBetween(3000, 7000)
    )
  }

  private lookTowardCursor(): void {
    if (!this.cursor) return
    const centerX = this.pos.x + this.env.windowSize.width / 2
    if (Math.abs(this.cursor.screenX - centerX) > 50) {
      this.facing = this.cursor.screenX < centerX ? -1 : 1
    }
  }

  private land(): void {
    this.state = 'land'
    this.landUntil = performance.now() + 320
    this.playTrigger('land')
  }

  private clampPosition(): void {
    const { workArea, windowSize } = this.env
    this.pos.x = clamp(
      this.pos.x,
      workArea.x - 14,
      workArea.x + workArea.width - windowSize.width + 14
    )
    this.pos.y = clamp(
      this.pos.y,
      workArea.y - 40,
      workArea.y + workArea.height - windowSize.height + 4
    )
  }

  private pushPosition(force = false): void {
    const now = performance.now()
    if (!force && now - this.lastPush < 30) return
    const x = Math.round(this.pos.x)
    const y = Math.round(this.pos.y)
    if (!force && x === this.lastSentPosition.x && y === this.lastSentPosition.y) return
    this.lastPush = now
    this.lastSentPosition = { x, y }
    this.options.api.pet.moveTo(x, y)
  }

  private update(dt: number, now: number): void {
    if (this.moodUntil && now > this.moodUntil) {
      this.moodUntil = 0
      this.setMood(this.sleeping ? 'sleepy' : 'neutral', 0)
    }
    if (now > this.nextBlinkAt) {
      this.blinkUntil = now + 150
      this.nextBlinkAt = now + randBetween(2600, 6800)
    }
    this.updateMovement(dt, now)
    this.updateAction(now)
    this.applyVisual(now)
    this.updateEyes()
    this.pushPosition()
  }

  private updateMovement(dt: number, now: number): void {
    if (this.dragging) return
    const cfg = this.options.getConfig()

    if (this.state === 'land' && now > this.landUntil) {
      this.state = 'idle'
      this.nextWanderAt = Math.max(this.restUntil, now + randBetween(4000, 12000))
    }

    if (this.state === 'walk') {
      const dx = this.targetX - this.pos.x
      if (Math.abs(dx) < 3) {
        this.pos.x = this.targetX
        this.state = 'idle'
        this.nextWanderAt = now + randBetween(6000, 16000)
      } else {
        const speed = cfg.pet.roamSpeed
        this.facing = dx < 0 ? -1 : 1
        this.pos.x += Math.sign(dx) * Math.min(speed * dt, Math.abs(dx))
      }
    }

    if (
      this.state === 'idle' &&
      !this.sleeping &&
      !this.chatOpen &&
      !this.cursor?.inside &&
      cfg.pet.roaming &&
      now >= this.nextWanderAt
    ) {
      const minX = this.env.workArea.x
      const maxX = this.env.workArea.x + this.env.workArea.width - this.env.windowSize.width
      let target = minX + Math.random() * Math.max(1, maxX - minX)
      if (Math.abs(target - this.pos.x) < 110) {
        target = this.pos.x + (Math.random() < 0.5 ? -1 : 1) * randBetween(110, 240)
      }
      this.targetX = clamp(target, Math.min(minX, maxX), Math.max(minX, maxX))
      this.state = 'walk'
    }

    this.clampPosition()
  }

  private updateAction(now: number): void {
    const action = this.currentAction
    if (!action) {
      if (!this.options.frameLayer.hidden) {
        this.options.frameLayer.hidden = true
        this.options.sprite.classList.remove('frames-active')
      }
      return
    }
    if (now >= action.endAt) {
      this.currentAction = null
      this.options.frameLayer.hidden = true
      this.options.frameLayer.removeAttribute('src')
      this.options.sprite.classList.remove('frames-active', 'wave')
      this.lastFrameSrc = ''
      return
    }
    if (action.frames.length > 0) {
      const elapsed = now - action.start
      const index = Math.min(
        action.frames.length - 1,
        Math.floor(elapsed / action.frameDuration)
      )
      const src = action.frames[index]
      if (src !== this.lastFrameSrc) {
        this.lastFrameSrc = src
        this.options.frameLayer.src = src
      }
      if (this.options.frameLayer.hidden) {
        this.options.frameLayer.hidden = false
        this.options.sprite.classList.add('frames-active')
      }
    }
  }

  private applyVisual(now: number): void {
    const t = (now - this.startedAt) / 1000
    let bob = 0
    let rot = 0
    let sx = 1
    let sy = 1
    let tx = 0

    switch (this.state) {
      case 'idle': {
        const breath = Math.sin(t * 2.2)
        sy = 1 + breath * 0.018
        sx = 1 - breath * 0.012
        bob = breath * 0.6
        break
      }
      case 'sleep': {
        const breath = Math.sin(t * 1.15)
        sy = 0.965 + breath * 0.012
        sx = 1 + breath * 0.009
        bob = 1 + breath * 0.4
        break
      }
      case 'walk': {
        const step = Math.abs(Math.sin(t * 9))
        bob = -step * 4
        rot = this.facing * 2 + Math.sin(t * 9) * 1.4
        sy = 1 - step * 0.015
        sx = 1 + step * 0.01
        break
      }
      case 'drag': {
        rot = this.facing * -2
        sy = 1.06
        sx = 0.95
        break
      }
      case 'land': {
        const p = clamp(1 - (this.landUntil - now) / 320, 0, 1)
        const squash = Math.sin(p * Math.PI)
        sy = 1 - squash * 0.18
        sx = 1 + squash * 0.14
        break
      }
      default:
        break
    }

    if (this.pulseUntil > now && this.pulseKind === 'click') {
      const p = 1 - (this.pulseUntil - now) / 420
      const squash = Math.sin(p * Math.PI)
      bob -= squash * 4
      sy *= 1 - squash * 0.05
      sx *= 1 + squash * 0.04
      rot += Math.sin(p * Math.PI * 4) * 1.6
    }

    const action = this.currentAction
    if (action) {
      const p = clamp((now - action.start) / action.animDuration, 0, 1)
      const damp = 1 - p
      switch (action.action.animation) {
        case 'bounce':
          bob -= Math.abs(Math.sin(p * Math.PI * 2)) * 14 * damp
          break
        case 'jump':
          bob -= Math.sin(p * Math.PI) * 26
          break
        case 'spin':
          rot += p * 360
          break
        case 'shake':
          tx += Math.sin(p * Math.PI * 8) * 5 * damp
          break
        case 'nod':
          rot += Math.sin(p * Math.PI * 4) * 7 * damp
          break
        case 'wobble':
          rot += Math.sin(p * Math.PI * 6) * 10 * damp
          break
        case 'wave':
          rot += Math.sin(p * Math.PI * 6) * 3 * damp
          break
        case 'squash': {
          const squash = Math.sin(p * Math.PI)
          sy *= 1 - squash * 0.2
          sx *= 1 + squash * 0.16
          break
        }
        case 'float':
          bob -= Math.sin(p * Math.PI) * 10
          rot += Math.sin(p * Math.PI * 2) * 2 * damp
          break
        default:
          break
      }
    }

    this.options.sprite.classList.toggle('blink', now < this.blinkUntil)
    this.options.sprite.classList.toggle('is-sleeping', this.sleeping)
    this.options.sprite.style.transform =
      `translate3d(${tx.toFixed(2)}px, ${bob.toFixed(2)}px, 0) ` +
      `rotate(${rot.toFixed(2)}deg) scale(${(sx * this.facing).toFixed(3)}, ${sy.toFixed(3)})`
  }

  private updateEyes(): void {
    const cfg = this.options.getConfig()
    if (
      !cfg.interaction.reactions.lookAtCursor ||
      !this.cursor ||
      this.dragging ||
      this.sleeping ||
      this.options.getPack().sprite.kind !== 'builtin'
    ) {
      setPupilOffset(this.options.baseHost, 0, 0)
      return
    }
    const centerX = this.pos.x + this.env.windowSize.width / 2
    const eyeY = this.pos.y + this.env.windowSize.height - 118 * cfg.pet.scale
    const dx = clamp((this.cursor.screenX - centerX) / 45, -3.4, 3.4)
    const dy = clamp((this.cursor.screenY - eyeY) / 60, -2.4, 2.4)
    setPupilOffset(this.options.baseHost, dx * this.facing, dy)
  }
}
