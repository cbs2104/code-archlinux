import type { PetPack } from '../../shared/types'
import { petAssetUrl } from '../../shared/defaults'
import { h, type Child, toast } from '../shared/dom'
import { builtinPetSvg } from '../pet/builtin'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export function button(
  label: string,
  onClick: (event: Event) => void,
  variant: ButtonVariant = 'secondary',
  options: { disabled?: boolean; title?: string } = {}
): HTMLButtonElement {
  return h('button', {
    class: `btn btn-${variant}`,
    text: label,
    title: options.title,
    disabled: options.disabled,
    on: { click: onClick }
  })
}

export function card(...children: Child[]): HTMLElement {
  return h('section', { class: 'card' }, ...children)
}

export function field(label: string, control: HTMLElement, hintText?: string): HTMLElement {
  return h(
    'label',
    { class: 'field' },
    h('span', { class: 'field-label', text: label }),
    control,
    hintText ? h('span', { class: 'field-hint', text: hintText }) : null
  )
}

export function row(
  label: string,
  control: HTMLElement,
  options: { hint?: string; stacked?: boolean } = {}
): HTMLElement {
  return h(
    'div',
    { class: `row${options.stacked ? ' row-stacked' : ''}` },
    h(
      'div',
      { class: 'row-text' },
      h('span', { class: 'row-label', text: label }),
      options.hint ? h('span', { class: 'row-hint', text: options.hint }) : null
    ),
    h('div', { class: 'row-control' }, control)
  )
}

export function section(
  title: string,
  description: string | null,
  ...children: Child[]
): HTMLElement {
  return h(
    'section',
    { class: 'section' },
    h(
      'header',
      { class: 'section-head' },
      h('h3', { text: title }),
      description ? h('p', { text: description }) : null
    ),
    ...children
  )
}

export function badge(
  text: string,
  tone: 'ok' | 'warn' | 'muted' | 'accent' = 'muted'
): HTMLElement {
  return h('span', { class: `badge badge-${tone}`, text })
}

export interface ToggleOptions {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  hint?: string
}

export function toggle(options: ToggleOptions): HTMLElement {
  const input = h('input', {
    type: 'checkbox',
    checked: options.checked,
    on: {
      change: () => options.onChange(input.checked)
    }
  })
  return row(options.label, h('span', { class: 'switch' }, input), { hint: options.hint })
}

export interface SelectOption {
  value: string
  label: string
}

export function select(options: {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
}): HTMLSelectElement {
  const node = h(
    'select',
    {
      class: 'input select',
      on: {
        change: () => options.onChange(node.value)
      }
    },
    ...options.options.map((option) =>
      h('option', {
        value: option.value,
        text: option.label
      })
    )
  )
  node.value = options.value
  return node
}

export function textInput(options: {
  value: string
  placeholder?: string
  type?: string
  onInput?: (value: string) => void
  onChange?: (value: string) => void
  mono?: boolean
}): HTMLInputElement {
  const input = h('input', {
    class: `input${options.mono ? ' mono' : ''}`,
    type: options.type ?? 'text',
    value: options.value,
    placeholder: options.placeholder,
    on: {
      input: () => options.onInput?.(input.value),
      change: () => options.onChange?.(input.value)
    }
  })
  return input
}

export function textarea(options: {
  value: string
  placeholder?: string
  rows?: number
  onChange: (value: string) => void
}): HTMLTextAreaElement {
  const node = h('textarea', {
    class: 'input textarea',
    placeholder: options.placeholder,
    value: options.value,
    attrs: { rows: String(options.rows ?? 4) },
    on: {
      change: () => options.onChange(node.value)
    }
  })
  return node
}

export function hint(text: string): HTMLElement {
  return h('p', { class: 'hint', text })
}

export function kbd(text: string): HTMLElement {
  return h('kbd', { text })
}

export function emptyState(text: string, action?: HTMLElement): HTMLElement {
  return h('div', { class: 'empty' }, h('p', { text }), action ?? null)
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const match = /Error invoking remote method '[^']+': (?:Error: )?(.*)$/.exec(error.message)
    return match ? match[1] : error.message
  }
  return String(error)
}

export function notifyError(error: unknown): void {
  toast(errorMessage(error), 'error', 4200)
}

export interface SliderOptions {
  label: string
  value: number
  min: number
  max: number
  step: number
  format?: (value: number) => string
  onChange: (value: number) => void
  hint?: string
}

export interface SliderControl {
  el: HTMLElement
  input: HTMLInputElement
  valueEl: HTMLElement
}

export function slider(options: SliderOptions): SliderControl {
  const format = options.format ?? ((value: number): string => String(value))
  const valueEl = h('span', { class: 'slider-value', text: format(options.value) })
  const input = h('input', {
    class: 'range',
    type: 'range',
    min: options.min,
    max: options.max,
    step: options.step,
    value: String(options.value),
    on: {
      input: () => {
        const value = Number(input.value)
        valueEl.textContent = format(value)
        options.onChange(value)
      }
    }
  })
  const el = row(options.label, h('div', { class: 'slider-wrap' }, input, valueEl), {
    hint: options.hint
  })
  return { el, input, valueEl }
}

export function petThumb(pack: PetPack, size = 84): HTMLElement {
  const wrap = h('div', {
    class: 'pet-thumb',
    style: { width: `${size}px`, height: `${size}px` }
  })
  if (pack.sprite.kind === 'image' && pack.sprite.asset) {
    wrap.append(
      h('img', {
        attrs: {
          src: `${petAssetUrl(pack.id, pack.sprite.asset)}?v=${pack.updatedAt}`,
          alt: pack.name,
          draggable: 'false'
        }
      })
    )
  } else {
    wrap.innerHTML = builtinPetSvg()
  }
  return wrap
}
