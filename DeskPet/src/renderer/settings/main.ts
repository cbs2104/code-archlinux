import type { SettingsTab } from '../../shared/types'
import { toast } from '../shared/dom'
import { AboutTab } from './about-tab'
import { ActionsTab } from './actions-tab'
import { AiTab } from './ai-tab'
import { InteractionTab } from './interaction-tab'
import { PetTab } from './pet-tab'
import { SettingsState, type SettingsContext, type TabView } from './state'
import { StudioTab } from './studio-tab'
import { VoiceTab } from './voice-tab'
import { notifyError } from './ui'

const api = window.deskpet
const state = new SettingsState(api)

const META: Record<SettingsTab, { title: string; desc: string }> = {
  pet: { title: '我的桌宠', desc: '管理形象、大小和位置' },
  studio: { title: '抠图工坊', desc: '从任意图片里抠出你的桌宠' },
  actions: { title: '动作与声音', desc: '给它安排对键盘、鼠标和 AI 的反应' },
  voice: { title: '语音', desc: '选择音色，决定什么时候说话' },
  interaction: { title: '互动与快捷键', desc: '键盘鼠标联动、待机与全局快捷键' },
  ai: { title: 'AI 伙伴', desc: '接入 OpenAI 兼容模型，让它真正会聊天' },
  about: { title: '关于 DeskPet', desc: '版本、文件位置、构建方式' }
}

const content = document.getElementById('content') as HTMLElement
const pageTitle = document.getElementById('page-title') as HTMLElement
const pageDesc = document.getElementById('page-desc') as HTMLElement
const nav = document.getElementById('nav') as HTMLElement

let currentId: SettingsTab = 'pet'
let currentView: TabView | null = null
const views = new Map<SettingsTab, TabView>()

const ctx: SettingsContext = {
  api,
  state,
  openTab: (tab) => showTab(tab),
  rerender: () => showTab(currentId, true),
  notify: (message, kind = 'info') => toast(message, kind)
}

function createView(tab: SettingsTab): TabView {
  switch (tab) {
    case 'studio':
      return new StudioTab(ctx)
    case 'actions':
      return new ActionsTab(ctx)
    case 'voice':
      return new VoiceTab(ctx)
    case 'interaction':
      return new InteractionTab(ctx)
    case 'ai':
      return new AiTab(ctx)
    case 'about':
      return new AboutTab(ctx)
    case 'pet':
    default:
      return new PetTab(ctx)
  }
}

function showTab(tab: SettingsTab, force = false): void {
  if (!force && tab === currentId && currentView) {
    currentView.onShow?.()
    return
  }
  currentId = tab
  nav.querySelectorAll<HTMLButtonElement>('button[data-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tab)
  })
  pageTitle.textContent = META[tab].title
  pageDesc.textContent = META[tab].desc
  let view = views.get(tab)
  if (!view) {
    view = createView(tab)
    views.set(tab, view)
  }
  currentView = view
  content.replaceChildren(view.el)
  content.scrollTop = 0
  view.onShow?.()
}

async function init(): Promise<void> {
  try {
    await state.load()
  } catch (error) {
    notifyError(error)
  }

  nav.querySelectorAll<HTMLButtonElement>('button[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      const tab = button.dataset.tab as SettingsTab | undefined
      if (tab) showTab(tab)
    })
  })

  document.getElementById('open-chat')?.addEventListener('click', () => api.pet.openChat())
  document.getElementById('toggle-pet')?.addEventListener('click', () => {
    void api.pet.toggle()
  })
  document.getElementById('open-data')?.addEventListener('click', () => {
    void api.app.openPath(state.info.userData).catch(notifyError)
  })

  api.settings.onTab((tab) => showTab(tab))

  api.config.onChange((config) => {
    state.config = config
    const recentlyLocal = Date.now() - state.lastLocalPatch < 900
    const active = document.activeElement
    const typing =
      active instanceof HTMLElement &&
      content.contains(active) &&
      (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')
    if (recentlyLocal || typing) return
    currentView?.refresh?.()
  })

  api.pets.onChange((packs) => {
    state.packs = packs
    if (currentId === 'pet' || currentId === 'studio') currentView?.refresh?.()
  })

  showTab('pet')

  if (!state.config.ai.enabled) {
    window.setTimeout(() => {
      toast('提示：在「AI 伙伴」里填入接口，就能和桌宠聊天啦', 'info', 4200)
    }, 900)
  }
}

void init()
