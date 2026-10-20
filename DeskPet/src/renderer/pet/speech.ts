import type { AppConfig } from '../../shared/types'

export class Speaker {
  private voices: SpeechSynthesisVoice[] = []
  private soundCache = new Map<string, HTMLAudioElement>()
  private hideTimer = 0
  private currentAudio: HTMLAudioElement | null = null
  private onBubbleToggle: (() => void) | null = null

  constructor(
    private readonly getConfig: () => AppConfig,
    private readonly bubble: HTMLElement,
    private readonly bubbleText: HTMLElement
  ) {
    this.refreshVoices()
    if (typeof speechSynthesis !== 'undefined') {
      speechSynthesis.addEventListener('voiceschanged', () => this.refreshVoices())
    }
  }

  setOnBubbleToggle(cb: () => void): void {
    this.onBubbleToggle = cb
  }

  refreshVoices(): void {
    if (typeof speechSynthesis === 'undefined') return
    this.voices = speechSynthesis.getVoices()
  }

  private pickVoice(): SpeechSynthesisVoice | null {
    const cfg = this.getConfig().voice
    if (!this.voices.length) this.refreshVoices()
    if (cfg.voiceUri) {
      const exact = this.voices.find((voice) => voice.voiceURI === cfg.voiceUri)
      if (exact) return exact
    }
    const language = cfg.language.toLowerCase()
    return (
      this.voices.find((voice) => voice.lang.toLowerCase() === language) ??
      this.voices.find((voice) => voice.lang.toLowerCase().startsWith(language.split('-')[0])) ??
      null
    )
  }

  speak(text: string): void {
    const cfg = this.getConfig().voice
    if (!cfg.enabled || !text.trim()) return
    if (typeof speechSynthesis === 'undefined') return
    this.stopSpeaking()
    const clean = text
      .replace(/\[\[[a-z]+\]\]/gi, '')
      .replace(/[`*_#>]/g, '')
      .replace(/```[\s\S]*?```/g, '代码')
      .replace(/https?:\/\/\S+/g, '链接')
      .trim()
    if (!clean) return
    const utterance = new SpeechSynthesisUtterance(clean.slice(0, 600))
    const voice = this.pickVoice()
    if (voice) utterance.voice = voice
    utterance.lang = voice?.lang || cfg.language
    utterance.rate = cfg.rate
    utterance.pitch = cfg.pitch
    utterance.volume = cfg.volume
    try {
      speechSynthesis.speak(utterance)
    } catch {
      /* TTS is optional; the bubble still shows the text */
    }
  }

  stopSpeaking(): void {
    try {
      if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel()
    } catch {
      /* ignore */
    }
  }

  say(text: string, options: { speak?: boolean; durationMs?: number } = {}): void {
    if (!text) return
    this.bubbleText.textContent = text
    this.bubble.classList.remove('hidden', 'bubble-hidden')
    this.bubble.classList.add('bubble-show')
    this.onBubbleToggle?.()
    if (this.hideTimer) window.clearTimeout(this.hideTimer)
    const duration = options.durationMs ?? Math.min(12000, 3200 + text.length * 65)
    this.hideTimer = window.setTimeout(() => this.hideBubble(), duration)
    if (options.speak) this.speak(text)
  }

  hideBubble(): void {
    if (this.hideTimer) {
      window.clearTimeout(this.hideTimer)
      this.hideTimer = 0
    }
    this.bubble.classList.remove('bubble-show')
    this.bubble.classList.add('bubble-hidden')
    window.setTimeout(() => {
      if (this.bubble.classList.contains('bubble-hidden')) this.bubble.classList.add('hidden')
      this.onBubbleToggle?.()
    }, 180)
    this.onBubbleToggle?.()
  }

  playSound(src: string): void {
    if (!src) return
    const cfg = this.getConfig().voice
    try {
      let audio = this.soundCache.get(src)
      if (!audio) {
        audio = new Audio(src)
        this.soundCache.set(src, audio)
      }
      audio.volume = Math.max(0, Math.min(1, cfg.volume * cfg.sfxVolume))
      audio.currentTime = 0
      this.currentAudio?.pause()
      this.currentAudio = audio
      void audio.play().catch(() => {
        /* autoplay may still be blocked on some Linux setups */
      })
    } catch {
      /* ignore unsupported formats */
    }
  }

  stopSound(): void {
    this.currentAudio?.pause()
    this.currentAudio = null
  }
}
