import { DEFAULT_SYSTEM_PROMPT } from '../../shared/defaults'
import type { AiSettings, DeepPartial } from '../../shared/types'
import { AI_PRESETS } from '../../shared/types'
import { h, toast } from '../shared/dom'
import type { SettingsContext, TabView } from './state'
import {
  button,
  card,
  field,
  hint,
  notifyError,
  section,
  select,
  slider,
  textarea,
  textInput,
  toggle
} from './ui'

export class AiTab implements TabView {
  readonly el = h('div', { class: 'tab-body' })
  private statusEl = h('span', { class: 'muted', text: '' })
  private pending: Partial<AiSettings> = {}
  private timer = 0
  private keyInput: HTMLInputElement | null = null
  private baseInput: HTMLInputElement | null = null
  private modelInput: HTMLInputElement | null = null
  private sttModelInput: HTMLInputElement | null = null
  private promptInput: HTMLTextAreaElement | null = null
  private presetSelect: HTMLSelectElement | null = null
  private enableCheckbox: HTMLInputElement | null = null
  private sttCheckbox: HTMLInputElement | null = null

  constructor(private readonly ctx: SettingsContext) {
    this.render()
  }

  onShow(): void {
    this.render()
  }

  private queue(patch: Partial<AiSettings>): void {
    Object.assign(this.pending, patch)
    if (this.timer) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      const pending = this.pending
      this.pending = {}
      this.timer = 0
      void this.ctx.state.patch({ ai: pending as DeepPartial<AiSettings> })
    }, 260)
  }

  private render(): void {
    const cfg = this.ctx.state.config.ai
    const preset = AI_PRESETS.find((item) => item.baseUrl && item.baseUrl === cfg.baseUrl)
    this.presetSelect = select({
      value: preset?.id ?? 'custom',
      options: AI_PRESETS.map((item) => ({
        value: item.id,
        label: item.baseUrl ? `${item.label} · ${item.model}` : item.label
      })),
      onChange: (value) => {
        const chosen = AI_PRESETS.find((item) => item.id === value)
        if (!chosen) return
        if (chosen.id === 'custom') {
          this.queue({ baseUrl: cfg.baseUrl, model: cfg.model })
          return
        }
        void this.ctx.state
          .patch({ ai: { baseUrl: chosen.baseUrl, model: chosen.model } })
          .then(() => this.render())
      }
    })

    this.baseInput = textInput({
      value: cfg.baseUrl,
      placeholder: 'https://api.openai.com/v1',
      mono: true,
      onChange: (value) => this.queue({ baseUrl: value.trim() })
    })
    this.keyInput = textInput({
      value: cfg.apiKey,
      placeholder: 'sk-…（本地模型可以留空）',
      type: 'password',
      mono: true,
      onChange: (value) => this.queue({ apiKey: value.trim() })
    })
    this.modelInput = textInput({
      value: cfg.model,
      placeholder: 'gpt-4o-mini',
      mono: true,
      onChange: (value) => this.queue({ model: value.trim() })
    })
    this.sttModelInput = textInput({
      value: cfg.sttModel,
      placeholder: 'whisper-1',
      mono: true,
      onChange: (value) => this.queue({ sttModel: value.trim() })
    })
    this.promptInput = textarea({
      value: cfg.systemPrompt,
      rows: 7,
      placeholder: '描述桌宠的性格、说话方式…',
      onChange: (value) => this.queue({ systemPrompt: value })
    })
    this.enableCheckbox = h('input', {
      type: 'checkbox',
      checked: cfg.enabled,
      on: {
        change: () => void this.ctx.state.patch({ ai: { enabled: this.enableCheckbox?.checked ?? false } })
      }
    })
    this.sttCheckbox = h('input', {
      type: 'checkbox',
      checked: cfg.sttEnabled,
      on: {
        change: () =>
          void this.ctx.state.patch({ ai: { sttEnabled: this.sttCheckbox?.checked ?? false } })
      }
    })

    const reveal = button('显示', () => {
      if (!this.keyInput) return
      this.keyInput.type = this.keyInput.type === 'password' ? 'text' : 'password'
      reveal.textContent = this.keyInput.type === 'password' ? '显示' : '隐藏'
    }, 'ghost')

    this.el.replaceChildren(
      card(
        section(
          'AI 伙伴',
          '接入任何 OpenAI 兼容接口（OpenAI、DeepSeek、Moonshot、通义、Ollama、LM Studio…）。',
          h(
            'div',
            { class: 'row' },
            h(
              'div',
              { class: 'row-text' },
              h('span', { class: 'row-label', text: '启用 AI 聊天' }),
              h('span', { class: 'row-hint', text: '关闭时桌宠仍可互动，但不会调用模型。' })
            ),
            h('div', { class: 'row-control' }, h('span', { class: 'switch' }, this.enableCheckbox))
          ),
          field(
            '服务预设',
            this.presetSelect,
            AI_PRESETS.find((item) => item.id === (preset?.id ?? 'custom'))?.hint
          ),
          field('Base URL', this.baseInput, '需要包含 /v1 等版本前缀，程序会拼接 /chat/completions。'),
          h(
            'div',
            { class: 'field' },
            h('span', { class: 'field-label', text: 'API Key' }),
            h('div', { class: 'input-with-action' }, this.keyInput, reveal),
            h('span', {
              class: 'field-hint',
              text: '只保存在本机配置里；系统支持时会用安全存储加密。'
            })
          ),
          field('模型名称', this.modelInput, '例如 gpt-4o-mini、deepseek-chat、qwen-plus、qwen2.5:7b'),
          h(
            'div',
            { class: 'action-row' },
            button('🔌 测试连接', () => void this.test(), 'primary'),
            button('💬 打开对话', () => this.ctx.api.pet.openChat()),
            button(
              '🧹 清空聊天记忆',
              () => {
                void this.ctx.api.history.clear().then(() => toast('聊天记忆已清空', 'success'))
              },
              'ghost'
            )
          ),
          this.statusEl
        )
      ),
      card(
        section(
          '生成参数',
          null,
          slider({
            label: '温度（越高越活泼）',
            value: cfg.temperature,
            min: 0,
            max: 1.6,
            step: 0.05,
            format: (value) => value.toFixed(2),
            onChange: (value) => this.queue({ temperature: value })
          }).el,
          slider({
            label: '单次回复上限',
            value: cfg.maxTokens,
            min: 64,
            max: 2048,
            step: 32,
            format: (value) => `${Math.round(value)} tokens`,
            onChange: (value) => this.queue({ maxTokens: Math.round(value) })
          }).el,
          slider({
            label: '记忆轮数',
            value: cfg.historyLimit,
            min: 2,
            max: 30,
            step: 1,
            format: (value) => `${Math.round(value)} 轮`,
            onChange: (value) => this.queue({ historyLimit: Math.round(value) })
          }).el,
          toggle({
            label: '流式输出（逐字出现）',
            checked: cfg.streaming,
            onChange: (value) => this.queue({ streaming: value }),
            hint: '关闭后要等完整回复一次性出现；部分本地模型更兼容非流式。'
          })
        )
      ),
      card(
        section(
          '桌宠人格',
          '这段提示词决定它说话的风格和身份。最后会自动附加它的名字和当前时间。',
          this.promptInput,
          h(
            'div',
            { class: 'action-row' },
            button(
              '保存人格',
              () => {
                const value = this.promptInput?.value ?? cfg.systemPrompt
                void this.ctx.state.patch({ ai: { systemPrompt: value } }).then(() => {
                  toast('人格设定已保存', 'success')
                })
              },
              'primary'
            ),
            button(
              '恢复默认人格',
              () => {
                void this.ctx.state
                  .patch({ ai: { systemPrompt: DEFAULT_SYSTEM_PROMPT } })
                  .then(() => {
                    toast('已恢复默认人格', 'success')
                    this.render()
                  })
              },
              'ghost'
            )
          ),
          hint('可以让模型在回复末尾输出 [[happy]] / [[sad]] / [[think]] 等标记来切换表情，标记会被自动移除。')
        )
      ),
      card(
        section(
          '语音识别（可选）',
          '使用同一个 API 的 /audio/transcriptions 接口，把聊天窗口里的录音转成文字。',
          h(
            'div',
            { class: 'row' },
            h(
              'div',
              { class: 'row-text' },
              h('span', { class: 'row-label', text: '启用语音识别' }),
              h('span', { class: 'row-hint', text: 'OpenAI、Groq 等支持 Whisper 接口的服务。' })
            ),
            h('div', { class: 'row-control' }, h('span', { class: 'switch' }, this.sttCheckbox))
          ),
          field('识别模型', this.sttModelInput, 'OpenAI 用 whisper-1；其他服务请填它支持的模型名。'),
          hint('如果服务不支持语音识别，请关闭这个开关；录音按钮会显示错误提示，不影响文字聊天。')
        )
      )
    )
    this.statusEl.textContent = ''
    this.statusEl.className = 'muted'
  }

  private async test(): Promise<void> {
    const cfg = this.ctx.state.config.ai
    const baseUrl = this.baseInput?.value.trim() ?? cfg.baseUrl
    const model = this.modelInput?.value.trim() ?? cfg.model
    const apiKey = this.keyInput?.value.trim() ?? cfg.apiKey
    this.statusEl.textContent = '正在连接…'
    this.statusEl.className = 'muted'
    await this.ctx.state.patch({ ai: { baseUrl, model, apiKey } })
    try {
      const result = await this.ctx.api.ai.test()
      this.statusEl.textContent = result.message
      this.statusEl.className = result.ok ? 'status-ok' : 'status-error'
      toast(result.message, result.ok ? 'success' : 'error', 4000)
    } catch (error) {
      this.statusEl.textContent = '测试失败'
      this.statusEl.className = 'status-error'
      notifyError(error)
    }
  }
}
