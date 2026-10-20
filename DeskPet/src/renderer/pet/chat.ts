import type {
  AiChunkEvent,
  AiDoneEvent,
  AiErrorEvent,
  AppConfig,
  ChatHistoryEntry,
  PetPack,
  PetTrigger
} from '../../shared/types'
import type { DeskPetApi } from '../../shared/types'
import { h, renderMarkdown, toast } from '../shared/dom'
import type { PetMood } from './builtin'

export interface ChatDeps {
  api: DeskPetApi
  getConfig: () => AppConfig
  getPack: () => PetPack
  onOpenChange: (open: boolean) => void
  setMood: (mood: PetMood) => void
  playTrigger: (trigger: PetTrigger) => void
  speakReply: (text: string) => void
}

const EMOTION_RE = /\[\[(happy|sad|think|sleepy|love)\]\]/gi

function newId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`
  }
}

export class ChatPanel {
  private open = false
  private messages: ChatHistoryEntry[] = []
  private loaded = false
  private sending = false
  private requestId: string | null = null
  private pendingText = ''
  private pendingEl: HTMLElement | null = null
  private renderQueued = false
  private recorder: MediaRecorder | null = null
  private chunks: BlobPart[] = []
  private recordingStream: MediaStream | null = null
  private recordTimer = 0

  private readonly panel: HTMLElement
  private readonly logEl: HTMLElement
  private readonly input: HTMLTextAreaElement
  private readonly sendBtn: HTMLButtonElement
  private readonly micBtn: HTMLButtonElement
  private readonly statusEl: HTMLElement
  private readonly nameEl: HTMLElement
  private readonly modelEl: HTMLElement

  constructor(private readonly deps: ChatDeps) {
    this.panel = document.getElementById('chat') as HTMLElement
    this.logEl = document.getElementById('chat-log') as HTMLElement
    this.input = document.getElementById('chat-text') as HTMLTextAreaElement
    this.sendBtn = document.getElementById('chat-send') as HTMLButtonElement
    this.micBtn = document.getElementById('chat-mic') as HTMLButtonElement
    this.statusEl = document.getElementById('chat-status') as HTMLElement
    this.nameEl = document.getElementById('chat-name') as HTMLElement
    this.modelEl = document.getElementById('chat-model') as HTMLElement

    this.bind()
    this.deps.api.ai.onChunk((event) => this.onChunk(event))
    this.deps.api.ai.onDone((event) => this.onDone(event))
    this.deps.api.ai.onError((event) => this.onError(event))
  }

  isOpen(): boolean {
    return this.open
  }

  updateHeader(): void {
    this.syncHeader()
  }

  async openPanel(): Promise<void> {
    if (this.open) {
      this.input.focus()
      return
    }
    this.open = true
    this.panel.classList.remove('hidden')
    this.deps.onOpenChange(true)
    await this.deps.api.pet.setChatOpen(true)
    this.syncHeader()
    if (!this.loaded) await this.loadHistory()
    this.render()
    window.setTimeout(() => {
      this.input.focus()
      this.scrollToBottom()
    }, 80)
  }

  async closePanel(): Promise<void> {
    if (!this.open) return
    this.open = false
    this.stopRecording(true)
    if (this.requestId) this.deps.api.ai.cancel(this.requestId)
    this.panel.classList.add('hidden')
    await this.deps.api.pet.setChatOpen(false)
    this.deps.onOpenChange(false)
  }

  async toggle(): Promise<void> {
    if (this.open) await this.closePanel()
    else await this.openPanel()
  }

  private bind(): void {
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault()
        void this.send()
      }
    })
    this.input.addEventListener('input', () => this.resizeInput())
    this.sendBtn.addEventListener('click', () => {
      if (this.sending) {
        this.cancelRequest()
        return
      }
      void this.send()
    })
    this.micBtn.addEventListener('click', () => {
      void this.toggleRecording()
    })
    document.getElementById('chat-close')?.addEventListener('click', () => {
      void this.closePanel()
    })
    document.getElementById('chat-clear')?.addEventListener('click', () => {
      void this.clearHistory()
    })
  }

  private syncHeader(): void {
    const cfg = this.deps.getConfig()
    const pack = this.deps.getPack()
    this.nameEl.textContent = pack.name
    this.modelEl.textContent = cfg.ai.enabled ? cfg.ai.model || '未选择模型' : 'AI 未启用'
    this.setStatus('')
  }

  private async loadHistory(): Promise<void> {
    this.loaded = true
    try {
      this.messages = await this.deps.api.history.load()
    } catch {
      this.messages = []
    }
  }

  private async persist(): Promise<void> {
    try {
      await this.deps.api.history.save(this.messages.slice(-60))
    } catch {
      /* history is a convenience, never block the chat */
    }
  }

  private render(): void {
    this.logEl.replaceChildren()
    if (this.messages.length === 0) {
      this.renderIntro()
    } else {
      for (const message of this.messages.slice(-60)) {
        this.logEl.append(this.buildMessage(message.role, message.content))
      }
    }
    this.scrollToBottom()
  }

  private renderIntro(): void {
    const cfg = this.deps.getConfig()
    const pack = this.deps.getPack()
    const intro = h(
      'div',
      { class: 'msg msg-assistant' },
      h(
        'div',
        { class: 'msg-body' },
        h('p', {
          text: pack.greeting || `你好呀，我是${pack.name}！点我聊天，或者把鼠标放到我身上试试～`
        }),
        h('p', {
          class: 'msg-hint',
          text: cfg.ai.enabled
            ? '可以直接问我问题，我会在桌面上回答你。'
            : '还没有接入 AI 大脑，只能陪你玩小动作。'
        })
      )
    )
    this.logEl.append(intro)
    if (!cfg.ai.enabled) {
      this.logEl.append(
        h(
          'button',
          {
            class: 'chat-enable',
            on: {
              click: () => this.deps.api.pet.openSettings('ai')
            }
          },
          '⚡ 去启用 AI'
        )
      )
    }
  }

  private buildMessage(role: 'user' | 'assistant', content: string): HTMLElement {
    const body = h('div', { class: 'msg-body' })
    if (role === 'assistant') body.innerHTML = renderMarkdown(content)
    else body.textContent = content
    return h('div', { class: `msg msg-${role}` }, body)
  }

  private scrollToBottom(): void {
    this.logEl.scrollTop = this.logEl.scrollHeight
  }

  private resizeInput(): void {
    this.input.style.height = 'auto'
    this.input.style.height = `${Math.min(110, this.input.scrollHeight)}px`
  }

  private setStatus(text: string, kind: 'info' | 'error' = 'info'): void {
    if (!text) {
      this.statusEl.classList.add('hidden')
      this.statusEl.textContent = ''
      return
    }
    this.statusEl.classList.remove('hidden')
    this.statusEl.textContent = text
    this.statusEl.classList.toggle('status-error', kind === 'error')
  }

  private setSending(sending: boolean): void {
    this.sending = sending
    this.sendBtn.textContent = sending ? '■' : '➤'
    this.sendBtn.classList.toggle('stop', sending)
    this.sendBtn.title = sending ? '停止回复' : '发送'
  }

  async send(preset?: string): Promise<void> {
    if (this.sending) return
    const cfg = this.deps.getConfig()
    const text = (preset ?? this.input.value).trim()
    if (!text) return
    if (!cfg.ai.enabled) {
      this.messages.push({ role: 'user', content: text, at: Date.now() })
      this.messages.push({
        role: 'assistant',
        content: '我还没有接上 AI 大脑…点右上角的设置，在「AI 伙伴」里填一个接口就能陪我聊天啦。',
        at: Date.now()
      })
      this.input.value = ''
      this.resizeInput()
      this.render()
      void this.persist()
      return
    }

    this.input.value = ''
    this.resizeInput()
    this.setStatus('')
    this.messages.push({ role: 'user', content: text, at: Date.now() })
    this.logEl.append(this.buildMessage('user', text))
    this.pendingText = ''
    this.pendingEl = this.buildMessage('assistant', '')
    this.pendingEl.classList.add('streaming')
    const body = this.pendingEl.querySelector('.msg-body')
    if (body) body.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>'
    this.logEl.append(this.pendingEl)
    this.scrollToBottom()
    void this.persist()

    const pack = this.deps.getPack()
    const capacity = Math.max(2, cfg.ai.historyLimit) * 2
    const history = this.messages
      .filter((message) => message.content.trim())
      .slice(-capacity)
      .map((message) => ({ role: message.role, content: message.content }))
    const system = [
      cfg.ai.systemPrompt,
      `你现在的名字是「${pack.name}」。`,
      `现在是 ${new Date().toLocaleString('zh-CN')}。`
    ].join('\n')

    this.requestId = newId()
    this.setSending(true)
    this.deps.api.ai.chat({
      requestId: this.requestId,
      messages: [{ role: 'system', content: system }, ...history]
    })
  }

  private cancelRequest(): void {
    if (!this.requestId) return
    this.deps.api.ai.cancel(this.requestId)
    this.setStatus('已停止回复')
  }

  private scheduleRender(): void {
    if (this.renderQueued) return
    this.renderQueued = true
    window.setTimeout(() => {
      this.renderQueued = false
      if (!this.pendingEl) return
      const body = this.pendingEl.querySelector('.msg-body')
      if (body) body.innerHTML = renderMarkdown(this.pendingText.replace(EMOTION_RE, '') || '…')
      this.pendingEl.classList.add('streaming')
      this.scrollToBottom()
    }, 50)
  }

  private onChunk(event: AiChunkEvent): void {
    if (event.requestId !== this.requestId) return
    this.pendingText += event.delta
    this.scheduleRender()
  }

  private onDone(event: AiDoneEvent): void {
    if (event.requestId !== this.requestId) return
    const raw = event.text || this.pendingText
    const text = raw.replace(EMOTION_RE, '').trim()
    if (this.pendingEl) {
      const body = this.pendingEl.querySelector('.msg-body')
      if (body) {
        body.innerHTML = text ? renderMarkdown(text) : '<span class="msg-hint">（没有内容）</span>'
      }
      this.pendingEl.classList.remove('streaming')
    }
    if (text) {
      this.messages.push({ role: 'assistant', content: text, at: Date.now() })
      void this.persist()
      const cfg = this.deps.getConfig()
      if (cfg.voice.speakReplies) this.deps.speakReply(text)
      this.deps.playTrigger('ai-reply')
    }
    const mood = /\[\[(happy|sad|think|sleepy|love)\]\]/i.exec(raw)
    if (mood) this.deps.setMood(mood[1].toLowerCase() as PetMood)
    this.finishRequest()
  }

  private onError(event: AiErrorEvent): void {
    if (event.requestId !== this.requestId) return
    if (this.pendingEl) {
      const body = this.pendingEl.querySelector('.msg-body')
      if (body) {
        body.replaceChildren(h('span', { class: 'msg-error', text: `⚠ ${event.message}` }))
      }
      this.pendingEl.classList.remove('streaming')
    }
    this.setStatus(event.message, 'error')
    toast(event.message, 'error', 4000)
    this.finishRequest()
  }

  private finishRequest(): void {
    this.requestId = null
    this.pendingEl = null
    this.pendingText = ''
    this.setSending(false)
    this.scrollToBottom()
  }

  private async toggleRecording(): Promise<void> {
    if (this.recorder) {
      this.stopRecording()
      return
    }
    const cfg = this.deps.getConfig()
    if (!cfg.ai.sttEnabled) {
      this.setStatus('语音识别还没开启：设置 →「AI 伙伴」→ 语音识别', 'error')
      toast('请先在设置里启用语音识别，并填写 Whisper 兼容模型', 'info', 3800)
      return
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      this.setStatus('当前系统不支持录音', 'error')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      this.recordingStream = stream
      const preferred = 'audio/webm;codecs=opus'
      const mime = MediaRecorder.isTypeSupported(preferred) ? preferred : ''
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      this.chunks = []
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) this.chunks.push(event.data)
      }
      recorder.onstop = () => {
        this.releaseStream()
        void this.finishRecording(recorder.mimeType || mime || 'audio/webm')
      }
      recorder.start()
      this.recorder = recorder
      this.micBtn.classList.add('recording')
      this.setStatus('正在听…再点一下结束（最长 30 秒）')
      this.recordTimer = window.setTimeout(() => this.stopRecording(), 30000)
    } catch (error) {
      this.setStatus(`无法使用麦克风：${(error as Error).message}`, 'error')
      toast('无法使用麦克风，请检查系统权限', 'error', 3600)
    }
  }

  private stopRecording(cancel = false): void {
    if (this.recordTimer) {
      window.clearTimeout(this.recordTimer)
      this.recordTimer = 0
    }
    this.micBtn.classList.remove('recording')
    const recorder = this.recorder
    this.recorder = null
    if (!recorder) {
      this.releaseStream()
      return
    }
    if (cancel) {
      recorder.onstop = null
      this.chunks = []
      try {
        if (recorder.state !== 'inactive') recorder.stop()
      } catch {
        /* ignore */
      }
      this.releaseStream()
      this.setStatus('')
      return
    }
    try {
      if (recorder.state !== 'inactive') recorder.stop()
    } catch {
      this.releaseStream()
    }
  }

  private releaseStream(): void {
    this.recordingStream?.getTracks().forEach((track) => track.stop())
    this.recordingStream = null
  }

  private async finishRecording(mime: string): Promise<void> {
    const chunks = this.chunks
    this.chunks = []
    if (chunks.length === 0) {
      this.setStatus('没有录到声音', 'error')
      return
    }
    const blob = new Blob(chunks, { type: mime })
    this.setStatus('正在识别…')
    try {
      const buffer = await blob.arrayBuffer()
      const text = await this.deps.api.ai.transcribe(buffer, blob.type || mime)
      if (text) {
        this.input.value = `${this.input.value} ${text}`.trim()
        this.resizeInput()
        this.input.focus()
        this.setStatus('')
      } else {
        this.setStatus('没有听清，再说一次？', 'error')
      }
    } catch (error) {
      const message = (error as Error).message || '语音识别失败'
      this.setStatus(message, 'error')
      toast(message, 'error', 4000)
    }
  }

  private async clearHistory(): Promise<void> {
    try {
      await this.deps.api.history.clear()
    } catch {
      /* ignore */
    }
    this.messages = []
    this.render()
  }
}
