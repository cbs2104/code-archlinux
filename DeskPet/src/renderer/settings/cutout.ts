/**
 * Dependency-free cutout/image-matte helpers.
 *
 * The functions in this file operate on raw RGBA bytes so they can be unit
 * tested in Node and reused by the canvas editor without pulling DOM APIs into
 * the algorithm layer.
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

export interface AutoMatteOptions {
  /** 0..255, higher removes more near-border colours */
  tolerance: number
  /** keep only the biggest connected foreground island */
  keepLargest: boolean
  /** soft edge radius in pixels; 0 keeps the binary matte */
  feather: number
  /** 0..100, removes the old background colour from semi-transparent edges */
  decontaminate: number
}

export interface AutoMatteStats {
  palette: Rgb[]
  removedPixels: number
  keptPixels: number
  edgePixels: number
}

export interface RefineOptions {
  /** negative contracts, positive expands */
  expand: number
  /** 0..12 */
  smooth: number
  /** 0..12 */
  feather: number
  /** 0..100 */
  decontaminate: number
}

export interface AlphaBounds {
  x: number
  y: number
  width: number
  height: number
}

const TRANSPARENT = 8
const ALPHA_THRESHOLD = 16
const MAX_PALETTE = 8

/** Perceptually weighted RGB distance, normalised to roughly 0..255. */
export function colorDistance(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number
): number {
  const dr = r1 - r2
  const dg = g1 - g2
  const db = b1 - b2
  return Math.sqrt((2 * dr * dr + 4 * dg * dg + 3 * db * db) / 9)
}

/**
 * Build a small background palette from the image border. Quantising first
 * keeps the palette stable when the border contains gradients or JPEG noise.
 */
export function collectBackgroundPalette(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  preferTransparent = false
): Rgb[] {
  if (width < 1 || height < 1) return []
  const buckets = new Map<number, { r: number; g: number; b: number; count: number }>()
  const perimeter = Math.max(1, 2 * width + 2 * height)
  const step = Math.max(1, Math.floor(perimeter / 5000))

  const add = (x: number, y: number): void => {
    const index = (y * width + x) * 4
    const r = data[index]
    const g = data[index + 1]
    const b = data[index + 2]
    const a = data[index + 3]
    if (a === 0 && r + g + b === 0) return
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.r += r
      bucket.g += g
      bucket.b += b
      bucket.count += 1
    } else {
      buckets.set(key, { r, g, b, count: 1 })
    }
  }

  let transparentSamples = 0
  if (preferTransparent) {
    const stride = Math.max(1, Math.floor(Math.sqrt((width * height) / 20000)))
    for (let y = 0; y < height; y += stride) {
      for (let x = 0; x < width; x += stride) {
        const offset = (y * width + x) * 4
        if (data[offset + 3] > TRANSPARENT) continue
        if (data[offset] + data[offset + 1] + data[offset + 2] === 0) continue
        add(x, y)
        transparentSamples += 1
      }
    }
    if (transparentSamples < 12) buckets.clear()
  }

  if (transparentSamples < 12) {
    for (let x = 0; x < width; x += step) {
      add(x, 0)
      add(x, height - 1)
    }
    for (let y = 0; y < height; y += step) {
      add(0, y)
      add(width - 1, y)
    }
  }

  const raw = [...buckets.values()]
    .map((bucket) => ({
      r: Math.round(bucket.r / bucket.count),
      g: Math.round(bucket.g / bucket.count),
      b: Math.round(bucket.b / bucket.count),
      count: bucket.count
    }))
    .sort((a, b) => b.count - a.count)

  const total = raw.reduce((sum, item) => sum + item.count, 0)
  const palette: Rgb[] = []
  for (const item of raw) {
    if (palette.length >= MAX_PALETTE) break
    if (item.count < total * 0.006 && palette.length > 0) continue
    const duplicate = palette.some(
      (color) => colorDistance(color.r, color.g, color.b, item.r, item.g, item.b) < 9
    )
    if (!duplicate) palette.push({ r: item.r, g: item.g, b: item.b })
  }
  if (palette.length === 0 && raw.length > 0) {
    palette.push({ r: raw[0].r, g: raw[0].g, b: raw[0].b })
  }
  return palette
}

function nearestColor(
  r: number,
  g: number,
  b: number,
  palette: Rgb[]
): { distance: number; color: Rgb | null } {
  let best = 255
  let bestColor: Rgb | null = null
  for (const color of palette) {
    const distance = colorDistance(r, g, b, color.r, color.g, color.b)
    if (distance < best) {
      best = distance
      bestColor = color
    }
  }
  return { distance: best, color: bestColor }
}

function buildBackgroundMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  palette: Rgb[],
  tolerance: number
): Uint8Array {
  const mask = new Uint8Array(width * height)
  const queue = new Uint32Array(width * height)
  let head = 0
  let tail = 0
  const limit = Math.max(1, tolerance)
  const localLimit = Math.max(9, limit * 0.55)
  const globalLimit = Math.max(limit, limit * 2.15)

  const seed = (x: number, y: number): void => {
    const index = y * width + x
    if (mask[index]) return
    const offset = index * 4
    if (data[offset + 3] <= TRANSPARENT) {
      mask[index] = 1
      queue[tail++] = index
      return
    }
    const nearest = nearestColor(data[offset], data[offset + 1], data[offset + 2], palette)
    if (nearest.distance <= limit) {
      mask[index] = 1
      queue[tail++] = index
    }
  }

  for (let x = 0; x < width; x += 1) {
    seed(x, 0)
    seed(x, height - 1)
  }
  for (let y = 1; y < height - 1; y += 1) {
    seed(0, y)
    seed(width - 1, y)
  }

  while (head < tail) {
    const index = queue[head++]
    const offset = index * 4
    const currentAlpha = data[offset + 3]
    const cr = data[offset]
    const cg = data[offset + 1]
    const cb = data[offset + 2]
    const x = index % width
    const y = (index / width) | 0

    const visit = (nx: number, ny: number): void => {
      const next = ny * width + nx
      if (mask[next]) return
      const nextOffset = next * 4
      const alpha = data[nextOffset + 3]
      if (alpha <= TRANSPARENT) {
        mask[next] = 1
        queue[tail++] = next
        return
      }
      const nr = data[nextOffset]
      const ng = data[nextOffset + 1]
      const nb = data[nextOffset + 2]
      const nearest = nearestColor(nr, ng, nb, palette)
      if (nearest.distance > globalLimit) return
      if (currentAlpha > TRANSPARENT) {
        const local = colorDistance(cr, cg, cb, nr, ng, nb)
        if (local > localLimit) return
      }
      mask[next] = 1
      queue[tail++] = next
    }

    if (x > 0) visit(x - 1, y)
    if (x < width - 1) visit(x + 1, y)
    if (y > 0) visit(x, y - 1)
    if (y < height - 1) visit(x, y + 1)
  }
  return mask
}

function alphaFromMask(
  data: Uint8ClampedArray,
  mask: Uint8Array,
  width: number,
  height: number
): Uint8ClampedArray {
  const alpha = new Uint8ClampedArray(width * height)
  for (let i = 0; i < alpha.length; i += 1) {
    if (mask[i]) alpha[i] = 0
    else alpha[i] = data[i * 4 + 3]
  }
  return alpha
}

/** Separable box blur for an 8-bit alpha plane. Radius 0 returns a copy. */
export function boxBlurAlpha(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number
): Uint8ClampedArray {
  const r = Math.max(0, Math.floor(radius))
  if (r === 0) return new Uint8ClampedArray(source)
  const horizontal = new Uint8ClampedArray(source.length)
  const output = new Uint8ClampedArray(source.length)
  const window = r * 2 + 1

  for (let y = 0; y < height; y += 1) {
    const row = y * width
    let sum = 0
    for (let x = -r; x <= r; x += 1) {
      sum += source[row + Math.min(width - 1, Math.max(0, x))]
    }
    for (let x = 0; x < width; x += 1) {
      horizontal[row + x] = sum / window
      const add = Math.min(width - 1, x + r + 1)
      const remove = Math.max(0, x - r)
      sum += source[row + add] - source[row + remove]
    }
  }

  for (let x = 0; x < width; x += 1) {
    let sum = 0
    for (let y = -r; y <= r; y += 1) {
      sum += horizontal[Math.min(height - 1, Math.max(0, y)) * width + x]
    }
    for (let y = 0; y < height; y += 1) {
      output[y * width + x] = sum / window
      const add = Math.min(height - 1, y + r + 1)
      const remove = Math.max(0, y - r)
      sum += horizontal[add * width + x] - horizontal[remove * width + x]
    }
  }
  return output
}

function shiftAlpha(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  amount: number
): Uint8ClampedArray {
  const steps = Math.min(16, Math.abs(Math.trunc(amount)))
  if (steps === 0) return new Uint8ClampedArray(source)
  let current = new Uint8ClampedArray(source)
  for (let step = 0; step < steps; step += 1) {
    const next = new Uint8ClampedArray(current.length)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let value = amount > 0 ? 0 : 255
        for (let oy = -1; oy <= 1; oy += 1) {
          const ny = y + oy
          if (ny < 0 || ny >= height) continue
          for (let ox = -1; ox <= 1; ox += 1) {
            const nx = x + ox
            if (nx < 0 || nx >= width) continue
            const sample = current[ny * width + nx]
            value = amount > 0 ? Math.max(value, sample) : Math.min(value, sample)
          }
        }
        next[y * width + x] = value
      }
    }
    current = next
  }
  return current
}

function removeSmallIslands(
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
  keepLargest: boolean
): number {
  const labels = new Uint32Array(alpha.length)
  const queue = new Uint32Array(alpha.length)
  const sizes: number[] = [0]
  let nextLabel = 1

  for (let start = 0; start < alpha.length; start += 1) {
    if (labels[start] !== 0 || alpha[start] <= ALPHA_THRESHOLD) continue
    const label = nextLabel
    nextLabel += 1
    sizes.push(0)
    let head = 0
    let tail = 0
    labels[start] = label
    queue[tail++] = start
    while (head < tail) {
      const index = queue[head++]
      sizes[label] += 1
      const x = index % width
      const y = (index / width) | 0
      const neighbours = [
        x > 0 ? index - 1 : -1,
        x < width - 1 ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y < height - 1 ? index + width : -1
      ]
      for (const next of neighbours) {
        if (next < 0 || labels[next] !== 0 || alpha[next] <= ALPHA_THRESHOLD) continue
        labels[next] = label
        queue[tail++] = next
      }
    }
  }

  let largest = 0
  for (let label = 1; label < sizes.length; label += 1) {
    if (sizes[label] > (sizes[largest] ?? 0)) largest = label
  }
  if (largest === 0) return 0
  const largestSize = sizes[largest] ?? 0
  const minimum = keepLargest ? largestSize : Math.max(24, Math.round(largestSize * 0.004))
  let removed = 0
  for (let index = 0; index < alpha.length; index += 1) {
    if (labels[index] !== 0 && sizes[labels[index]] < minimum) {
      alpha[index] = 0
      removed += 1
    }
  }
  return removed
}

function softenBoundary(
  data: Uint8ClampedArray,
  mask: Uint8Array,
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
  palette: Rgb[],
  tolerance: number
): void {
  const low = Math.max(2, tolerance * 0.42)
  const high = Math.max(low + 1, tolerance * 1.8)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      if (mask[index] || alpha[index] === 0) continue
      let touchesBackground = false
      for (let oy = -1; oy <= 1 && !touchesBackground; oy += 1) {
        const ny = y + oy
        if (ny < 0 || ny >= height) continue
        for (let ox = -1; ox <= 1; ox += 1) {
          const nx = x + ox
          if (nx < 0 || nx >= width) continue
          if (mask[ny * width + nx]) {
            touchesBackground = true
            break
          }
        }
      }
      if (!touchesBackground) continue
      const offset = index * 4
      const nearest = nearestColor(data[offset], data[offset + 1], data[offset + 2], palette)
      const soft = Math.min(1, Math.max(0, (nearest.distance - low) / (high - low)))
      const softened = Math.round(255 * soft)
      if (softened < alpha[index]) alpha[index] = softened
    }
  }
}

export function decontaminateEdges(
  data: Uint8ClampedArray,
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
  palette: Rgb[],
  strength: number
): number {
  if (palette.length === 0 || strength <= 0) return 0
  const amount = Math.min(1, Math.max(0, strength / 100)) * 0.85
  let touched = 0
  for (let i = 0; i < alpha.length; i += 1) {
    const a = alpha[i]
    if (a === 0 || a >= 250) continue
    const offset = i * 4
    const nr = data[offset]
    const ng = data[offset + 1]
    const nb = data[offset + 2]
    const nearest = nearestColor(nr, ng, nb, palette)
    if (!nearest.color) continue
    const opacity = a / 255
    if (opacity < 0.08) continue
    const bg = nearest.color
    const inv = 1 - opacity
    const fr = (nr - inv * bg.r) / opacity
    const fg = (ng - inv * bg.g) / opacity
    const fb = (nb - inv * bg.b) / opacity
    data[offset] = nr + (Math.min(255, Math.max(0, fr)) - nr) * amount
    data[offset + 1] = ng + (Math.min(255, Math.max(0, fg)) - ng) * amount
    data[offset + 2] = nb + (Math.min(255, Math.max(0, fb)) - nb) * amount
    touched += 1
  }
  return touched
}

function applyAlpha(
  data: Uint8ClampedArray,
  alpha: Uint8ClampedArray
): Pick<AutoMatteStats, 'removedPixels' | 'keptPixels' | 'edgePixels'> {
  let removed = 0
  let kept = 0
  let edge = 0
  for (let i = 0; i < alpha.length; i += 1) {
    const value = alpha[i]
    data[i * 4 + 3] = value
    if (value === 0) removed += 1
    else {
      kept += 1
      if (value < 250) edge += 1
    }
  }
  return { removedPixels: removed, keptPixels: kept, edgePixels: edge }
}

/**
 * Smart automatic matte:
 * 1. quantised border palette (handles gradients/noisy backgrounds),
 * 2. flood-fill guided by both the border model and local colour changes,
 * 3. connected-component clean-up,
 * 4. soft edge + optional background-colour decontamination.
 */
export function autoMatte(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: AutoMatteOptions
): AutoMatteStats {
  const palette = collectBackgroundPalette(data, width, height)
  const mask = buildBackgroundMask(data, width, height, palette, options.tolerance)
  let alpha = alphaFromMask(data, mask, width, height)
  removeSmallIslands(alpha, width, height, options.keepLargest)
  softenBoundary(data, mask, alpha, width, height, palette, options.tolerance)
  if (options.feather > 0) {
    alpha = boxBlurAlpha(alpha, width, height, options.feather)
  }
  decontaminateEdges(data, alpha, width, height, palette, options.decontaminate)
  const stats = applyAlpha(data, alpha)
  return { palette, ...stats }
}

/** Pixel-level edge polish used by the “边缘精修” panel. */
export function refineAlpha(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: RefineOptions
): Pick<AutoMatteStats, 'removedPixels' | 'keptPixels' | 'edgePixels'> {
  const palette = collectBackgroundPalette(data, width, height, true)
  let alpha: Uint8ClampedArray = new Uint8ClampedArray(width * height)
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = data[i * 4 + 3]
  alpha = shiftAlpha(alpha, width, height, options.expand)
  if (options.smooth > 0) alpha = boxBlurAlpha(alpha, width, height, options.smooth)
  if (options.feather > 0) alpha = boxBlurAlpha(alpha, width, height, options.feather)
  decontaminateEdges(data, alpha, width, height, palette, options.decontaminate)
  return applyAlpha(data, alpha)
}

export function cleanAlpha(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  keepLargest: boolean
): Pick<AutoMatteStats, 'removedPixels' | 'keptPixels' | 'edgePixels'> {
  const alpha = new Uint8ClampedArray(width * height)
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = data[i * 4 + 3]
  removeSmallIslands(alpha, width, height, keepLargest)
  return applyAlpha(data, alpha)
}

export function alphaBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  threshold = ALPHA_THRESHOLD
): AlphaBounds | null {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < minX || maxY < minY) return null
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}
