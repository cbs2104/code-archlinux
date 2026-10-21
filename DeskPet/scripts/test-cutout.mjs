/**
 * Dependency-free checks for the smart cutout algorithms used by the studio.
 * Run with: npm test
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const outDir = await mkdtemp(join(tmpdir(), 'deskpet-cutout-test-'))
const outFile = join(outDir, 'cutout.mjs')

try {
  await build({
    entryPoints: ['src/renderer/settings/cutout.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: outFile,
    logLevel: 'silent'
  })
  const { autoMatte, cleanAlpha, refineAlpha, alphaBounds, collectBackgroundPalette } = await import(
    pathToFileURL(outFile).href
  )

  const solid = makeImage(120, 100, (x, y) => {
    const subject = x >= 30 && x < 90 && y >= 20 && y < 80
    return subject ? [32, 72, 220, 255] : [242, 242, 242, 255]
  })
  const solidStats = autoMatte(solid, 120, 100, {
    tolerance: 34,
    keepLargest: true,
    feather: 1,
    decontaminate: 40
  })
  const alphaAt = (data, width, x, y) => data[(y * width + x) * 4 + 3]
  assert.equal(alphaAt(solid, 120, 0, 0), 0)
  assert.equal(alphaAt(solid, 120, 60, 50), 255)
  const softEdge = alphaAt(solid, 120, 30, 50)
  assert.ok(softEdge > 0 && softEdge < 255, `subject edge should be soft (got ${softEdge})`)
  assert.ok(solidStats.keptPixels > 3000, 'solid subject should survive')
  assert.ok(solidStats.palette.length >= 1, 'border palette should be detected')
  assert.equal(collectBackgroundPalette(solid, 120, 100)[0].r, 242)

  const gradient = makeImage(140, 100, (x, y) => {
    const subject = x >= 40 && x < 100 && y >= 18 && y < 82
    if (subject) return [28, 138, 96, 255]
    const shade = Math.round(218 + (x / 139) * 28)
    return [shade, shade, shade, 255]
  })
  autoMatte(gradient, 140, 100, {
    tolerance: 30,
    keepLargest: true,
    feather: 1,
    decontaminate: 30
  })
  assert.equal(alphaAt(gradient, 140, 0, 0), 0)
  assert.equal(alphaAt(gradient, 140, 70, 50), 255)

  const specks = makeImage(80, 80, () => [0, 0, 0, 0])
  paintRect(specks, 80, 10, 10, 30, 30, 255)
  paintRect(specks, 80, 60, 60, 62, 62, 255)
  cleanAlpha(specks, 80, 80, true)
  assert.equal(alphaAt(specks, 80, 20, 20), 255)
  assert.equal(alphaAt(specks, 80, 61, 61), 0, 'small island should be removed')

  const expanded = makeImage(20, 20, (x, y) => {
    const inside = x >= 8 && x < 12 && y >= 8 && y < 12
    return inside ? [255, 0, 0, 255] : [255, 255, 255, 0]
  })
  refineAlpha(expanded, 20, 20, {
    expand: 2,
    smooth: 0,
    feather: 0,
    decontaminate: 0
  })
  assert.equal(alphaAt(expanded, 20, 6, 10), 255, 'expand should grow the matte')
  assert.equal(alphaAt(expanded, 20, 0, 0), 0)

  const bounds = alphaBounds(expanded, 20, 20)
  assert.ok(bounds && bounds.width >= 8 && bounds.height >= 8)

  console.log('✓ smart cutout palette, matte, clean-up and edge refine checks passed')
} finally {
  await rm(outDir, { recursive: true, force: true })
}

function makeImage(width, height, colorAt) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = colorAt(x, y)
      const offset = (y * width + x) * 4
      data[offset] = r
      data[offset + 1] = g
      data[offset + 2] = b
      data[offset + 3] = a
    }
  }
  return data
}

function paintRect(data, width, x1, y1, x2, y2, alpha) {
  for (let y = y1; y < y2; y += 1) {
    for (let x = x1; x < x2; x += 1) {
      data[(y * width + x) * 4 + 3] = alpha
    }
  }
}
