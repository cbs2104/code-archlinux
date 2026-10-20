import type { AiChatRequest, AiTestResult, AppConfig } from '../shared/types'
import { log } from './logger'

export interface AiCallbacks {
  onChunk: (delta: string) => void
  onDone: (text: string) => void
  onError: (message: string) => void
}

const CHAT_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 20_000
const STT_TIMEOUT_MS = 60_000

export class AiService {
  private readonly controllers = new Map<string, AbortController>()

  constructor(private readonly getConfig: () => AppConfig) {}

  private get settings() {
    return this.getConfig().ai
  }

  private baseUrl(): string {
    const url = this.settings.baseUrl.trim().replace(/\/+$/, '')
    if (!url) throw new Error('还没有填写 API 地址，请到「AI 伙伴」里设置')
    return url
  }

  private headers(json: boolean): Record<string, string> {
    const headers: Record<string, string> = {}
    if (json) headers['Content-Type'] = 'application/json'
    const key = this.settings.apiKey.trim()
    if (key) headers.Authorization = `Bearer ${key}`
    return headers
  }

  private errorHint(status: number): string {
    switch (status) {
      case 401:
      case 403:
        return 'API Key 无效或没有权限'
      case 404:
        return '接口地址不正确，请确认 Base URL（通常以 /v1 结尾）'
      case 429:
        return '请求太频繁或额度不足'
      case 500:
      case 502:
      case 503:
        return 'AI 服务暂时不可用'
      default:
        return ''
    }
  }

  private async describe(response: Response): Promise<string> {
    let detail = ''
    try {
      const text = await response.text()
      if (text) {
        try {
          const json = JSON.parse(text) as {
            error?: { message?: string } | string
            message?: string
          }
          if (typeof json.error === 'string') detail = json.error
          else if (json.error?.message) detail = json.error.message
          else if (json.message) detail = json.message
          else detail = text
        } catch {
          detail = text
        }
      }
    } catch {
      /* ignore */
    }
    const hint = this.errorHint(response.status)
    const trimmed = detail.replace(/\s+/g, ' ').slice(0, 300)
    return `HTTP ${response.status}${hint ? `（${hint}）` : ''}${trimmed ? `：${trimmed}` : ''}`
  }

  async chat(request: AiChatRequest, callbacks: AiCallbacks): Promise<void> {
    const cfg = this.settings
    let settled = false
    const finish = (text: string): void => {
      if (settled) return
      settled = true
      callbacks.onDone(text)
    }
    const fail = (message: string): void => {
      if (settled) return
      settled = true
      callbacks.onError(message)
    }

    if (!cfg.enabled) {
      fail('AI 还没有开启，请到设置里启用并填写接口信息')
      return
    }
    if (!cfg.model) {
      fail('还没有填写模型名称')
      return
    }

    const controller = new AbortController()
    this.controllers.set(request.requestId, controller)
    const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS)

    let full = ''
    try {
      const response = await fetch(`${this.baseUrl()}/chat/completions`, {
        method: 'POST',
        headers: this.headers(true),
        signal: controller.signal,
        body: JSON.stringify({
          model: cfg.model,
          messages: request.messages,
          temperature: cfg.temperature,
          max_tokens: cfg.maxTokens,
          stream: cfg.streaming
        })
      })
      if (!response.ok) throw new Error(await this.describe(response))

      if (!cfg.streaming) {
        const json = (await response.json()) as {
          choices?: { message?: { content?: string } }[]
        }
        const text = json.choices?.[0]?.message?.content ?? ''
        if (!text) throw new Error('AI 返回了空内容')
        callbacks.onChunk(text)
        finish(text)
        return
      }

      if (!response.body) throw new Error('AI 服务没有返回可读取的数据流')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line.startsWith('data:')) {
            const data = line.slice(5).trim()
            if (data && data !== '[DONE]') {
              try {
                const parsed = JSON.parse(data) as {
                  choices?: { delta?: { content?: string } }[]
                }
                const delta = parsed.choices?.[0]?.delta?.content
                if (typeof delta === 'string' && delta) {
                  full += delta
                  callbacks.onChunk(delta)
                }
              } catch {
                /* keep-alive or partial line */
              }
            }
          }
          newline = buffer.indexOf('\n')
        }
      }
      if (!full.trim()) throw new Error('AI 没有返回内容，请检查模型名称与接口')
      finish(full)
    } catch (error) {
      if (controller.signal.aborted) {
        if (full.trim()) finish(full)
        else fail('回复已取消（或等待超时）')
      } else {
        const message = (error as Error).message || '未知错误'
        log.warn('AI request failed', message)
        fail(message)
      }
    } finally {
      clearTimeout(timer)
      this.controllers.delete(request.requestId)
    }
  }

  cancel(requestId: string): void {
    this.controllers.get(requestId)?.abort()
  }

  async test(): Promise<AiTestResult> {
    const cfg = this.settings
    if (!cfg.baseUrl.trim()) return { ok: false, message: '请先填写 Base URL' }
    if (!cfg.model.trim()) return { ok: false, message: '请先填写模型名称' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
    try {
      const base = this.baseUrl()
      const response = await fetch(`${base}/models`, {
        headers: this.headers(false),
        signal: controller.signal
      })
      if (response.ok) {
        let count = 0
        try {
          const json = (await response.json()) as { data?: unknown[] }
          count = Array.isArray(json.data) ? json.data.length : 0
        } catch {
          /* some providers return an empty body */
        }
        return {
          ok: true,
          message: `连接成功${count ? `，服务提供 ${count} 个模型` : ''}`
        }
      }
      if (response.status === 404 || response.status === 405) {
        return await this.ping()
      }
      return { ok: false, message: await this.describe(response) }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        return { ok: false, message: '连接超时，请检查网络或服务地址' }
      }
      return { ok: false, message: (error as Error).message }
    } finally {
      clearTimeout(timer)
    }
  }

  private async ping(): Promise<AiTestResult> {
    const cfg = this.settings
    const response = await fetch(`${this.baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
        stream: false
      })
    })
    if (!response.ok) return { ok: false, message: await this.describe(response) }
    await response.json().catch(() => null)
    return { ok: true, message: '连接成功，模型可以正常回复' }
  }

  async transcribe(data: ArrayBuffer, mime: string): Promise<string> {
    const cfg = this.settings
    if (!cfg.sttEnabled) throw new Error('语音识别未开启，请先在设置里启用')
    if (!cfg.sttModel) throw new Error('请先填写语音识别模型（如 whisper-1）')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), STT_TIMEOUT_MS)
    try {
      const bytes = new Uint8Array(data)
      if (bytes.byteLength === 0) throw new Error('没有录到声音')
      if (bytes.byteLength > 30 * 1024 * 1024) throw new Error('录音太大（上限 30MB）')
      const form = new FormData()
      const file = new Blob([bytes], { type: mime || 'audio/webm' })
      form.append('file', file, 'speech.webm')
      form.append('model', cfg.sttModel)
      const language = this.getConfig().voice.language.split('-')[0]
      if (language) form.append('language', language)
      const response = await fetch(`${this.baseUrl()}/audio/transcriptions`, {
        method: 'POST',
        headers: this.headers(false),
        body: form,
        signal: controller.signal
      })
      if (!response.ok) throw new Error(await this.describe(response))
      const json = (await response.json()) as { text?: string }
      return (json.text ?? '').trim()
    } finally {
      clearTimeout(timer)
    }
  }
}
