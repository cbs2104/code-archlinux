/**
 * Small dependency-free smoke test for the shared, DOM-free modules.
 * Bundles the TypeScript sources with esbuild (installed with Vite), then
 * verifies the invariants that both the main and renderer processes rely on.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const outDir = await mkdtemp(join(tmpdir(), 'deskpet-test-'))
const outFile = join(outDir, 'defaults.mjs')

try {
  await build({
    entryPoints: ['src/shared/defaults.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: outFile,
    logLevel: 'silent'
  })

  const mod = await import(pathToFileURL(outFile).href)
  const {
    DEFAULT_CONFIG,
    createBuiltinPack,
    defaultActions,
    mergeDeep,
    petAssetUrl,
    clamp,
    PET_WINDOW,
    CHAT_WINDOW
  } = mod

  // Defaults
  assert.equal(DEFAULT_CONFIG.activePetId, 'builtin')
  assert.equal(DEFAULT_CONFIG.pet.scale, 1)
  assert.equal(DEFAULT_CONFIG.ai.enabled, false)
  assert.ok(DEFAULT_CONFIG.ai.systemPrompt.length > 50)
  assert.equal(PET_WINDOW.width, 360)
  assert.ok(CHAT_WINDOW.height > PET_WINDOW.height)

  // Builtin pack and default actions
  const pack = createBuiltinPack()
  assert.equal(pack.schema, 'deskpet/pet@1')
  assert.equal(pack.id, 'builtin')
  assert.equal(pack.sprite.kind, 'builtin')
  assert.ok(pack.actions.length >= 10)
  for (const action of pack.actions) {
    assert.ok(action.id)
    assert.ok(action.name)
    assert.ok(action.cooldownMs >= 0)
    assert.ok(action.durationMs >= 100)
  }
  const cloned = defaultActions()
  cloned[0].name = 'changed'
  assert.notEqual(pack.actions[0].name, 'changed', 'defaultActions must deep clone')

  // Deep merge: nested objects merge, arrays replace, prototypes are protected
  const merged = mergeDeep(clone(DEFAULT_CONFIG), {
    pet: { scale: 1.3 },
    hotkeys: { togglePet: 'CommandOrControl+Shift+9' },
    interaction: { reactions: { typing: false } }
  })
  assert.equal(merged.pet.scale, 1.3)
  assert.equal(merged.pet.opacity, DEFAULT_CONFIG.pet.opacity)
  assert.equal(merged.hotkeys.togglePet, 'CommandOrControl+Shift+9')
  assert.equal(merged.interaction.reactions.typing, false)
  assert.equal(merged.interaction.reactions.mouseClick, true)
  assert.equal(merged.ai.apiKey, '')

  const replaced = mergeDeep({ list: [1, 2, 3] }, { list: [9] })
  assert.deepEqual(replaced.list, [9])

  const polluted = mergeDeep({}, JSON.parse('{"__proto__":{"polluted":true}}'))
  assert.equal(polluted.polluted, undefined)
  assert.equal({}.polluted, undefined)

  // Asset URL encoding
  assert.equal(petAssetUrl('abc-123', 'sprite.png'), 'deskpet://assets/abc-123/sprite.png')
  assert.equal(
    petAssetUrl('abc', 'frames/wave 1/0.png'),
    'deskpet://assets/abc/frames/wave%201/0.png'
  )
  assert.ok(petAssetUrl('a b', 'x.png').startsWith('deskpet://assets/a%20b/'))

  // clamp
  assert.equal(clamp(5, 0, 3), 3)
  assert.equal(clamp(-1, 0, 3), 0)
  assert.equal(clamp(2, 0, 3), 2)

  console.log('✓ shared defaults, merge, pack and asset URL checks passed')
} finally {
  await rm(outDir, { recursive: true, force: true })
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}
