export type Child = Node | string | null | undefined | false

export interface ElOptions {
  class?: string
  text?: string
  html?: string
  title?: string
  value?: string
  type?: string
  placeholder?: string
  checked?: boolean
  disabled?: boolean
  min?: string | number
  max?: string | number
  step?: string | number
  style?: Partial<CSSStyleDeclaration>
  attrs?: Record<string, string>
  on?: Record<string, (event: Event) => void>
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElOptions = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (options.class) node.className = options.class
  if (options.text !== undefined) node.textContent = options.text
  if (options.html !== undefined) node.innerHTML = options.html
  if (options.title) node.title = options.title
  if (options.type) node.setAttribute('type', options.type)
  if (options.placeholder) node.setAttribute('placeholder', options.placeholder)
  if (options.value !== undefined) {
    if (
      node instanceof HTMLInputElement ||
      node instanceof HTMLTextAreaElement ||
      node instanceof HTMLSelectElement
    ) {
      node.value = options.value
    } else {
      node.setAttribute('value', options.value)
    }
  }
  if (options.checked !== undefined && node instanceof HTMLInputElement) node.checked = options.checked
  if (options.disabled !== undefined && 'disabled' in node) {
    ;(node as HTMLButtonElement).disabled = options.disabled
  }
  if (options.min !== undefined) node.setAttribute('min', String(options.min))
  if (options.max !== undefined) node.setAttribute('max', String(options.max))
  if (options.step !== undefined) node.setAttribute('step', String(options.step))
  if (options.style) Object.assign(node.style, options.style)
  if (options.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) node.setAttribute(key, value)
  }
  if (options.on) {
    for (const [event, handler] of Object.entries(options.on)) {
      node.addEventListener(event, handler)
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(child))
  }
  return node
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Very small markdown subset that is safe to inject as HTML. */
export function renderMarkdown(text: string): string {
  let html = escapeHtml(text)
  html = html.replace(
    /```([\s\S]*?)```/g,
    (_m, code: string) => `<pre><code>${code.trim()}</code></pre>`
  )
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  html = html.replace(/\n/g, '<br>')
  return html
}

export function debounce<T extends (...args: never[]) => void>(
  fn: T,
  wait = 300
): (...args: Parameters<T>) => void {
  let timer: number | undefined
  return (...args: Parameters<T>) => {
    if (timer !== undefined) window.clearTimeout(timer)
    timer = window.setTimeout(() => fn(...args), wait)
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

export function toast(
  message: string,
  kind: 'info' | 'error' | 'success' = 'info',
  timeout = 2600
): void {
  let host = document.getElementById('toast-host')
  if (!host) {
    host = h('div', { attrs: { id: 'toast-host' } })
    document.body.append(host)
  }
  const node = h('div', { class: `toast toast-${kind}`, text: message })
  host.append(node)
  window.setTimeout(() => {
    node.classList.add('toast-out')
    window.setTimeout(() => node.remove(), 260)
  }, timeout)
}

export async function confirmDialog(options: {
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
}): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = h('div', { class: 'modal-overlay' })
    const close = (result: boolean): void => {
      overlay.remove()
      resolve(result)
    }
    const modal = h(
      'div',
      { class: 'modal-card' },
      h('h3', { text: options.title }),
      h('p', { class: 'modal-message', text: options.message }),
      h(
        'div',
        { class: 'modal-actions' },
        h('button', {
          class: 'btn btn-ghost',
          text: options.cancelText ?? '取消',
          on: { click: () => close(false) }
        }),
        h('button', {
          class: options.danger ? 'btn btn-danger' : 'btn btn-primary',
          text: options.confirmText ?? '确定',
          on: { click: () => close(true) }
        })
      )
    )
    overlay.append(modal)
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(false)
    })
    document.body.append(overlay)
  })
}

export async function promptDialog(options: {
  title: string
  message?: string
  value?: string
  placeholder?: string
  confirmText?: string
}): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = h('div', { class: 'modal-overlay' })
    const input = h('input', {
      class: 'input',
      value: options.value ?? '',
      placeholder: options.placeholder ?? ''
    })
    const close = (result: string | null): void => {
      overlay.remove()
      resolve(result)
    }
    const submit = (): void => close(input.value.trim() || null)
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit()
      if (event.key === 'Escape') close(null)
    })
    const modal = h(
      'div',
      { class: 'modal-card' },
      h('h3', { text: options.title }),
      options.message ? h('p', { class: 'modal-message', text: options.message }) : null,
      input,
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { class: 'btn btn-ghost', text: '取消', on: { click: () => close(null) } }),
        h('button', {
          class: 'btn btn-primary',
          text: options.confirmText ?? '确定',
          on: { click: submit }
        })
      )
    )
    overlay.append(modal)
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(null)
    })
    document.body.append(overlay)
    window.setTimeout(() => input.focus(), 30)
  })
}
