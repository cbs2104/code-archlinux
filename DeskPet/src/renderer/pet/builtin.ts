export type PetMood = 'neutral' | 'happy' | 'sad' | 'think' | 'sleepy' | 'love'

const MOUTH: Record<PetMood, string> = {
  neutral: 'M92 130 Q100 136 108 130',
  happy: 'M88 128 Q100 144 112 128',
  sad: 'M91 138 Q100 129 109 138',
  think: 'M92 133 Q100 130 108 133',
  sleepy: 'M94 133 L106 133',
  love: 'M89 128 Q100 143 111 128'
}

/**
 * A small inline SVG pet with separately addressable eyes and mouth so the
 * engine can blink, look around and change expression without any image files.
 */
export function builtinPetSvg(): string {
  return `
<svg id="builtin-pet" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <radialGradient id="bodyGrad" cx="42%" cy="30%" r="78%">
      <stop offset="0%" stop-color="#fff4ea" />
      <stop offset="52%" stop-color="#ffdcc3" />
      <stop offset="100%" stop-color="#f7b78f" />
    </radialGradient>
    <linearGradient id="earGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffd7c1" />
      <stop offset="100%" stop-color="#f2a985" />
    </linearGradient>
    <radialGradient id="bellyGrad" cx="50%" cy="45%" r="60%">
      <stop offset="0%" stop-color="#fffaf4" />
      <stop offset="100%" stop-color="#ffe6d4" />
    </radialGradient>
    <radialGradient id="shadowGrad" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="rgba(72,40,25,.30)" />
      <stop offset="100%" stop-color="rgba(72,40,25,0)" />
    </radialGradient>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="1.6" />
    </filter>
  </defs>

  <ellipse id="pet-shadow" cx="100" cy="185" rx="52" ry="9" fill="url(#shadowGrad)" filter="url(#soft)" />

  <g id="tail">
    <path d="M146 150 C176 148 182 124 166 108 C158 100 147 102 145 110"
      fill="none" stroke="#f8c3a4" stroke-width="13" stroke-linecap="round" />
    <path d="M146 150 C176 148 182 124 166 108"
      fill="none" stroke="#ffe0cc" stroke-width="5" stroke-linecap="round" opacity=".8" />
  </g>

  <g id="ears">
    <path d="M58 72 L55 32 L86 52 Z" fill="url(#earGrad)" stroke="#f2b493" stroke-width="1.5" stroke-linejoin="round" />
    <path d="M64 62 L62 42 L78 54 Z" fill="#ffb3bd" opacity=".85" />
    <path d="M142 72 L145 32 L114 52 Z" fill="url(#earGrad)" stroke="#f2b493" stroke-width="1.5" stroke-linejoin="round" />
    <path d="M136 62 L138 42 L122 54 Z" fill="#ffb3bd" opacity=".85" />
  </g>

  <g id="body">
    <path d="M100 44 C140 44 168 73 168 112 C168 153 140 176 100 176 C60 176 32 153 32 112 C32 73 60 44 100 44 Z"
      fill="url(#bodyGrad)" stroke="#edb391" stroke-width="1.6" />
    <ellipse cx="100" cy="130" rx="43" ry="36" fill="url(#bellyGrad)" opacity=".85" />
  </g>

  <g id="arms">
    <ellipse id="arm-left" cx="44" cy="132" rx="12" ry="17" fill="#ffd9c2" transform="rotate(-14 44 132)" />
    <g id="arm-right">
      <ellipse cx="156" cy="132" rx="12" ry="17" fill="#ffd9c2" transform="rotate(14 156 132)" />
    </g>
  </g>

  <g id="face">
    <g id="eyes">
      <g id="eye-left">
        <ellipse cx="78" cy="106" rx="9.5" ry="11" fill="#3c2a2a" />
        <ellipse cx="81" cy="102" rx="3.4" ry="4.2" fill="#fffaf6" />
        <ellipse cx="75" cy="110" rx="1.8" ry="2.2" fill="#fffaf6" opacity=".7" />
      </g>
      <g id="eye-right">
        <ellipse cx="122" cy="106" rx="9.5" ry="11" fill="#3c2a2a" />
        <ellipse cx="125" cy="102" rx="3.4" ry="4.2" fill="#fffaf6" />
        <ellipse cx="119" cy="110" rx="1.8" ry="2.2" fill="#fffaf6" opacity=".7" />
      </g>
    </g>

    <ellipse cx="67" cy="124" rx="8" ry="4.4" fill="#ff9fae" opacity=".55" />
    <ellipse cx="133" cy="124" rx="8" ry="4.4" fill="#ff9fae" opacity=".55" />

    <path id="nose" d="M96 120 Q100 117 104 120 Q100 125 96 120 Z" fill="#f28d9c" />
    <path id="mouth" d="${MOUTH.neutral}" fill="none" stroke="#a8675c" stroke-width="2.2" stroke-linecap="round" />

    <g id="whiskers" stroke="#d99c86" stroke-width="1.4" stroke-linecap="round" opacity=".7">
      <path d="M60 118 L40 114" />
      <path d="M60 124 L39 126" />
      <path d="M140 118 L160 114" />
      <path d="M140 124 L161 126" />
    </g>
  </g>

  <g id="feet">
    <ellipse cx="72" cy="172" rx="17" ry="7" fill="#ffd2b9" />
    <ellipse cx="128" cy="172" rx="17" ry="7" fill="#ffd2b9" />
  </g>
</svg>`
}

export function setMood(root: HTMLElement, mood: PetMood): void {
  const svg = root.querySelector<SVGSVGElement>('#builtin-pet')
  if (!svg) return
  const mouth = svg.querySelector<SVGPathElement>('#mouth')
  if (mouth) mouth.setAttribute('d', MOUTH[mood])
  const blush = svg.querySelectorAll<SVGEllipseElement>('#face > ellipse')
  blush.forEach((node) => {
    node.setAttribute('opacity', mood === 'happy' || mood === 'love' ? '0.8' : mood === 'sad' ? '0.3' : '0.55')
  })
  svg.classList.toggle('mood-sleep', mood === 'sleepy')
  svg.classList.toggle('mood-love', mood === 'love')
}

export function setPupilOffset(root: HTMLElement, dx: number, dy: number): void {
  const svg = root.querySelector<SVGSVGElement>('#builtin-pet')
  if (!svg) return
  const left = svg.querySelector<SVGGElement>('#eye-left')
  const right = svg.querySelector<SVGGElement>('#eye-right')
  const transform = `translate(${dx.toFixed(2)} ${dy.toFixed(2)})`
  left?.setAttribute('transform', transform)
  right?.setAttribute('transform', transform)
}
