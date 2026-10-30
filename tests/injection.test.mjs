import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, assert, assertEqual, tempStore } from './lib/harness.mjs'
import {
  apply,
  inject,
  composeInjection,
  renderIndexVariants,
  injectionMetrics,
} from '../index.js'

const emptySections = () => ({ identity: [], work: [], personal: [], technical: [], style: [] })
const profileWith = (sections) => ({ version: 1, updatedAt: 1, sections: { ...emptySections(), ...sections } })
const entry = (i, extra = {}) => ({
  id: `g-${i}`,
  sessionId: `s-${i}`,
  title: `T${i}`,
  keyPoints: `kp${i}`,
  category: 'general',
  lastActivity: 1000 - i,
  ...extra,
})
const bytesOf = (text) => Buffer.byteLength(text, 'utf8')
const indexLines = (variant) => variant.split('\n').filter((line) => /^\[\d+\]/.test(line))

test('the plugin declares exactly the three injection hooks it uses', () => {
  assertEqual(inject, ['agents', 'tools', 'systemPrompt'])
})

test('the profile block comes before the global index, and no session memory is injected', () => {
  const text = composeInjection(profileWith({ identity: ['用户是教师'] }), [entry(1)], 20, 8192)
  assert(text.includes('<user_profile>'), 'profile block present')
  assert(text.includes('<global_memory_index>'), 'index block present')
  assert(text.indexOf('<user_profile>') < text.indexOf('<global_memory_index>'), 'profile first')
  assert(!text.includes('<session_memory>'), 'the current session is never re-injected')
})

test('no entries means no index block at all (not an empty one)', () => {
  const text = composeInjection(profileWith({ identity: ['x'] }), [], 20, 8192)
  assert(text.includes('<user_profile>'))
  assert(!text.includes('<global_memory_index>'))
  assert(!text.includes('too large to list'), 'an empty index is not "too large"')
})

test('no profile points means no user_profile tag at all', () => {
  const text = composeInjection(profileWith({}), [entry(1)], 20, 8192)
  assert(!text.includes('<user_profile>'))
  assert(text.includes('<global_memory_index>'))
  assertEqual(composeInjection(null, [entry(1)], 20, 8192).includes('<user_profile>'), false)
})

test('an empty store injects the empty string', () => {
  assertEqual(composeInjection(profileWith({}), [], 20, 8192), '')
  assertEqual(composeInjection(null, [], 20, 8192), '')
})

test('composition is deterministic (the render cache and change detection rely on it)', () => {
  const profile = profileWith({ identity: ['a'], technical: ['b'] })
  const entries = [entry(1), entry(2), entry(3)]
  assertEqual(composeInjection(profile, entries, 2, 4096), composeInjection(profile, entries, 2, 4096))
})

test('injectLimit decides how many entries carry key points — never how many entries are listed', () => {
  const entries = [1, 2, 3, 4, 5].map((i) => entry(i))
  const variant = renderIndexVariants(entries, 2)[0]
  const lines = indexLines(variant)
  assertEqual(lines.length, 5, 'every session stays visible')
  for (let i = 1; i <= 5; i += 1) assert(variant.includes(`[${i}] (general) T${i}`), `entry ${i} listed`)
  assertEqual(lines.filter((line) => line.includes(' — ')).length, 2, 'only the first two carry key points')
})

test('injectLimit 0 degrades to titles, still listing every entry', () => {
  const entries = [1, 2, 3].map((i) => entry(i))
  const variant = renderIndexVariants(entries, 0)[0]
  const lines = indexLines(variant)
  assertEqual(lines.length, 3)
  assert(lines.every((line) => !line.includes(' — ')), 'no key points leak through')
})

test('a missing keyPoint still yields a title line rather than a gap', () => {
  const variant = renderIndexVariants([entry(1, { keyPoints: '' }), entry(2)], 20)[0]
  assertEqual(indexLines(variant).length, 2)
  assert(variant.includes('[1] (general) T1'))
})

test('long key points are clipped in the middle variants (24 chars + ellipsis)', () => {
  const long = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十'
  const variants = renderIndexVariants([entry(1, { keyPoints: long })], 20)
  assertEqual(variants[0].includes(long), true, 'the richest variant keeps it whole')
  const clipped = indexLines(variants[1])[0]
  assert(clipped.endsWith('…'), clipped)
  assert(clipped.includes('一二三四五六七八九十一二三四五六七'), '24 characters survive')
  assert(!clipped.includes(long), 'the tail is gone')
})

test('identical variants collapse instead of being injected twice', () => {
  const noKeyPoints = [entry(1, { keyPoints: '' }), entry(2, { keyPoints: '' })]
  const variants = renderIndexVariants(noKeyPoints, 20)
  assertEqual(variants.length, 2, 'titles-only and the too-large stub')
})

test('the byte budget picks the richest variant that fits', () => {
  const entries = Array.from({ length: 6 }, (_, i) => entry(i + 1, { keyPoints: 'x'.repeat(60) }))
  const variants = renderIndexVariants(entries, 20)
  const full = variants[0]
  const clipped = variants[1]
  assert(bytesOf(full) > bytesOf(clipped))
  assertEqual(composeInjection(null, entries, 20, bytesOf(clipped) + 10), clipped)
  assertEqual(composeInjection(null, entries, 20, bytesOf(full) + 10), full)
})

test('the index is never silently dropped, at any budget', () => {
  const entries = Array.from({ length: 8 }, (_, i) => entry(i + 1, { keyPoints: 'k'.repeat(80) }))
  const profile = profileWith({ identity: Array.from({ length: 12 }, (_, i) => `p${i}`) })
  for (const budget of [1, 50, 200, 600, 2000, 8192]) {
    const text = composeInjection(profile, entries, 20, budget)
    assert(
      text.includes('<global_memory_index>') || text.includes('too large to list'),
      `budget ${budget} lost the index entirely`,
    )
    assert(text.includes('<user_profile>'), `budget ${budget} lost the profile entirely`)
  }
})

test('under extreme pressure the profile collapses to head/tail lines and the stub survives', () => {
  const entries = Array.from({ length: 20 }, (_, i) => entry(i + 1))
  const profile = profileWith({ identity: Array.from({ length: 15 }, (_, i) => `point-${i}`) })
  const text = composeInjection(profile, entries, 20, 10)
  assert(text.includes('too large to list'), 'stub is the last resort')
  assert(text.includes('recall_memory(scope:"global")'), 'the stub tells the model how to recover')
  assert(text.includes('  - …'), 'the profile is cut to its first points')
  assert(text.includes('<user_profile>') && text.includes('</user_profile>'), 'the block stays well-formed')
  assert(!text.includes('point-9'), 'the tail of the profile is gone')
})

test('metrics price exactly the text that gets injected', () => {
  const profile = profileWith({ identity: ['a', 'b'], technical: ['c'] })
  const entries = [entry(1), entry(2, { keyPoints: 'y'.repeat(50) })]
  const config = { injectLimit: 20, maxInjectBytes: 8192 }
  const metrics = injectionMetrics(config, profile, entries, {})
  assertEqual(metrics.total.bytes, bytesOf(composeInjection(profile, entries, 20, 8192)))
  assertEqual(metrics.trimmed, false, 'a generous budget trims nothing')
  assertEqual(metrics.index.entriesShown, 2)
  assertEqual(metrics.index.entriesTotal, 2)
  assertEqual(metrics.index.keyPointEntries, 2)
})

test('metrics report trimming when the budget bites, and still count every entry', () => {
  const profile = profileWith({ identity: ['a'] })
  const entries = Array.from({ length: 5 }, (_, i) => entry(i + 1, { keyPoints: 'z'.repeat(60) }))
  const metrics = injectionMetrics({ injectLimit: 3, maxInjectBytes: 30 }, profile, entries, {})
  assertEqual(metrics.trimmed, true)
  assertEqual(metrics.index.entriesShown, 5, 'entriesShown is the logical count, even under the stub')
  assertEqual(metrics.index.keyPointEntries, 3)
})

test('apply registers one runtime context with order 130 and a synchronous text()', async () => {
  const store = await tempStore()
  try {
    const captured = []
    const ctx = {
      tools: { register: () => () => {} },
      systemPrompt: { context: (entryValue) => { captured.push(entryValue); return () => {} } },
      inject: () => {},
      get: () => undefined,
      on: () => {},
      effect: () => {},
    }
    apply(ctx, store.config)
    assertEqual(captured.length, 1, 'exactly one registration')
    assertEqual(captured[0].name, 'dsh-structured-memory')
    assertEqual(captured[0].order, 130, 'after DSH policy contexts')
    assertEqual(typeof captured[0].text, 'function')
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 30))
    await store.dispose()
  }
})

test('text() reflects file changes and never throws on a corrupt store', async () => {
  const store = await tempStore()
  try {
    const captured = []
    const ctx = {
      tools: { register: () => () => {} },
      systemPrompt: { context: (entryValue) => { captured.push(entryValue); return () => {} } },
      inject: () => {},
      get: () => undefined,
      on: () => {},
      effect: () => {},
    }
    apply(ctx, store.config)
    const text = captured[0].text

    assertEqual(text(), '', 'an empty store injects nothing')

    await writeFile(join(store.dir, 'profile.json'), JSON.stringify(profileWith({ identity: ['首轮画像'] })))
    await writeFile(join(store.dir, 'global.json'), JSON.stringify([entry(1)]))
    const first = text()
    assert(first.includes('首轮画像') && first.includes('T1'), 'both tiers rendered')

    // A second session appears → the next render must see it (mtime+size cache).
    await writeFile(join(store.dir, 'global.json'), JSON.stringify([entry(1), entry(2, { title: 'T2-new' })]))
    assert(text().includes('T2-new'), 'the cache is invalidated by the file change')

    // Corrupt files must degrade, never break prompt assembly.
    await writeFile(join(store.dir, 'global.json'), '{not json')
    let crashed = null
    let degraded = ''
    try {
      degraded = text()
    } catch (error) {
      crashed = error
    }
    assertEqual(crashed, null, 'assembly never throws')
    assert(degraded.includes('首轮画像'), 'the profile still renders')
    assert(!degraded.includes('<global_memory_index>'), 'the corrupt index is skipped')
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 30))
    await store.dispose()
  }
})
