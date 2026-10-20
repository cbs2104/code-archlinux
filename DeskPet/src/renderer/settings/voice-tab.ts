import type { DeepPartial, VoiceSettings } from '../../shared/types'
import { h, toast } from '../shared/dom'
import type { SettingsContext, TabView } from './state'
import { button, card, field, hint, section, select, slider, textInput, toggle } from './ui'

export class VoiceTab implements TabView {
  readonly el = h('div', { class: 'tab-body' })
  private voiceSelect: HTMLSelectElement | null = null
  private pending: Partial<VoiceSettings> = {}
  private timer = 0

  constructor(private readonly ctx: SettingsContext) {
    this.render()
    if (typeof speechSynthesis !== 'undefined') {
      speechSynthesis.addEventListener('voiceschanged', () => {
        if (this.el.isConnected) this.render()
      })
    }
  }

  onShow(): void {
    this.render()
  }

  private queue(patch: Partial<VoiceSettings>): void {
    Object.assign(this.pending, patch)
    if (this.timer) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      const pending = this.pending
      this.pending = {}
      this.timer = 0
      void this.ctx.state.patch({ voice: pending as DeepPartial<VoiceSettings> })
    }, 140)
  }

  private render(): void {
    const cfg = this.ctx.state.config.voice
    const voices = typeof speechSynthesis === 'undefined' ? [] : speechSynthesis.getVoices()
    this.voiceSelect = select({
      value: cfg.voiceUri,
      options: [
        { value: '', label: '自动选择（按语言）' },
        ...voices.map((voice) => ({
          value: voice.voiceURI,
          label: `${voice.name} · ${voice.lang}${voice.default ? ' · 默认' : ''}`
        }))
      ],
      onChange: (value) => {
        const voice = voices.find((item) => item.voiceURI === value)
        void this.ctx.state.patch({
          voice: { voiceUri: value, language: voice?.lang ?? cfg.language }
        })
      }
    })

    const testInput = textInput({
      value: '你好呀，我是你的桌面小搭档！',
      placeholder: '输入要试听的文字'
    })

    this.el.replaceChildren(
      card(
        section(
          '语音合成（TTS）',
          '让桌宠用系统语音读出动作台词和 AI 回复。Linux 需要 speech-dispatcher 或安装 espeak-ng。',
          toggle({
            label: '启用语音',
            checked: cfg.enabled,
            onChange: (value) => void this.ctx.state.patch({ voice: { enabled: value } })
          }),
          field('系统音色', this.voiceSelect, '列表来自操作系统；如果为空，说明系统没有可用的 TTS 引擎。'),
          h(
            'div',
            { class: 'action-row' },
            button('刷新音色列表', () => this.render()),
            button('试听', () => this.preview(testInput.value)),
            button('停止朗读', () => {
              speechSynthesis.cancel()
            }, 'ghost')
          ),
          field('试听文本', testInput),
          slider({
            label: '语速',
            value: cfg.rate,
            min: 0.5,
            max: 2,
            step: 0.05,
            format: (value) => `${value.toFixed(2)}×`,
            onChange: (value) => this.queue({ rate: value })
          }).el,
          slider({
            label: '音调',
            value: cfg.pitch,
            min: 0.5,
            max: 2,
            step: 0.05,
            format: (value) => value.toFixed(2),
            onChange: (value) => this.queue({ pitch: value })
          }).el,
          slider({
            label: '音量',
            value: cfg.volume,
            min: 0,
            max: 1,
            step: 0.05,
            format: (value) => `${Math.round(value * 100)}%`,
            onChange: (value) => this.queue({ volume: value })
          }).el,
          field(
            '语言',
            textInput({
              value: cfg.language,
              placeholder: 'zh-CN',
              onChange: (value) => void this.ctx.state.patch({ voice: { language: value.trim() || 'zh-CN' } })
            }),
            '例如 zh-CN、en-US、ja-JP。没有匹配音色时会回退到系统默认。'
          )
        )
      ),
      card(
        section(
          '什么时候说话',
          null,
          toggle({
            label: '朗读 AI 的回复',
            checked: cfg.speakReplies,
            onChange: (value) => void this.ctx.state.patch({ voice: { speakReplies: value } })
          }),
          toggle({
            label: '朗读动作台词',
            checked: cfg.speakActionLines,
            onChange: (value) => void this.ctx.state.patch({ voice: { speakActionLines: value } })
          }),
          slider({
            label: '动作音效音量',
            value: cfg.sfxVolume,
            min: 0,
            max: 1,
            step: 0.05,
            format: (value) => `${Math.round(value * 100)}%`,
            onChange: (value) => this.queue({ sfxVolume: value })
          }).el,
          hint('每个动作可以单独设置音频文件，在「动作与声音」里编辑。这比系统 TTS 更适合做角色配音。')
        )
      ),
      card(
        section(
          '语音输入（可选）',
          '聊天窗口的 🎤 按钮可以录音，并发送到 OpenAI 兼容的 /audio/transcriptions 接口识别成文字。',
          hint('启用方式：打开「AI 伙伴」→ 勾选「启用语音识别」，填写 whisper-1 等模型。'),
          h(
            'div',
            { class: 'action-row' },
            button('去 AI 设置', () => this.ctx.openTab('ai'), 'primary')
          )
        )
      )
    )
  }

  private preview(text: string): void {
    if (typeof speechSynthesis === 'undefined') {
      toast('当前环境不支持语音合成', 'error')
      return
    }
    const cfg = this.ctx.state.config.voice
    const clean = text.trim()
    if (!clean) return
    speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(clean)
    const voices = speechSynthesis.getVoices()
    const voice =
      voices.find((item) => item.voiceURI === cfg.voiceUri) ??
      voices.find((item) => item.lang.toLowerCase() === cfg.language.toLowerCase()) ??
      voices.find((item) => item.lang.toLowerCase().startsWith(cfg.language.split('-')[0]))
    if (voice) utterance.voice = voice
    utterance.lang = voice?.lang ?? cfg.language
    utterance.rate = cfg.rate
    utterance.pitch = cfg.pitch
    utterance.volume = cfg.volume
    speechSynthesis.speak(utterance)
  }
}
