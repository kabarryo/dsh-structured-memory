import { test, assert, assertEqual } from './lib/harness.mjs'
import { MEMORY_SKILL } from '../skill.js'

test('the skill name is kebab-case and the catalog summary stays small', () => {
  assert(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(MEMORY_SKILL.name), MEMORY_SKILL.name)
  assert([...MEMORY_SKILL.description].length <= 240, `description ${[...MEMORY_SKILL.description].length}`)
  assert([...MEMORY_SKILL.whenToUse].length <= 240, `whenToUse ${[...MEMORY_SKILL.whenToUse].length}`)
})

test('the skill body documents every retrieval level and its cost', () => {
  for (const needle of ['recall_memory', 'load_session_memory', 'timeline', 'files', 'scope']) {
    assert(MEMORY_SKILL.content.includes(needle), `body mentions ${needle}`)
  }
})

import { registerMemorySkill } from '../index.js'

test('registerMemorySkill registers once and reports availability', () => {
  const calls = []
  const effects = []
  const ctx = {
    get: (key) => (key === 'skills' ? { register: (skill) => { calls.push(skill); return () => {} } } : undefined),
    effect: (fn) => { effects.push(fn) },
  }
  assertEqual(registerMemorySkill(ctx), true)
  assertEqual(calls.length, 1)
  assertEqual(calls[0].name, MEMORY_SKILL.name)
  assertEqual(calls[0].content, MEMORY_SKILL.content)
  assertEqual(calls[0].source, 'runtime')
  assertEqual(effects.length, 1, 'the disposer is registered as an effect')
})

test('registerMemorySkill degrades when the host has no skills service', () => {
  assertEqual(registerMemorySkill({ get: () => undefined, effect: () => {} }), false)
})

test('registerMemorySkill survives a throwing registry (duplicate name on reload)', () => {
  const ctx = { get: () => ({ register: () => { throw new Error('duplicate') } }), effect: () => {} }
  assertEqual(registerMemorySkill(ctx), false)
})

import { buildToolDescriptions, SAVE_MEMORY_CONTENT_RULE } from '../index.js'

test('compact descriptions fit the budget and keep every hard gate', () => {
  const compact = buildToolDescriptions({ skillGuide: true })
  const long = buildToolDescriptions({ skillGuide: false })

  // 1320 leaves room for the mandatory correction clause without letting the
  // description drift back up to its pre-v2.20 size.
  assert([...compact.save].length <= 1320, `save ${[...compact.save].length}`)
  assert([...compact.recall].length <= 320, `recall ${[...compact.recall].length}`)
  assert([...compact.load].length <= 220, `load ${[...compact.load].length}`)

  for (const trigger of ['user-request', 'acceptance', 'decision', 'correction']) {
    assert(compact.save.includes(trigger), `compact save keeps trigger ${trigger}`)
  }
  for (const gate of ['evidence', 'keyPoint', 'profileUpdate', 'profileSection', 'ONE memory']) {
    assert(compact.save.includes(gate), `compact save keeps ${gate}`)
  }
  assert(compact.save.includes(MEMORY_SKILL.name), 'compact save points at the skill')
  assert(compact.recall.includes(MEMORY_SKILL.name), 'compact recall points at the skill')

  // The fallback must stay the FULL text, and must actually interpolate the
  // content rule: pre-v2.20 shipped a literal "${SAVE_MEMORY_CONTENT_RULE}",
  // so the model never saw the rule at all (measured: 2,009 chars with the
  // placeholder, not 2,814).
  assert(!long.save.includes('${'), 'fallback carries no unexpanded placeholder')
  assert(long.save.includes(SAVE_MEMORY_CONTENT_RULE), 'fallback interpolates the content rule')
  assert([...long.save].length >= 2700, `long save ${[...long.save].length}`)
  assert(long.save.includes('DO NOT CALL IT'), 'fallback keeps the exclusion list')

  const total = (d) => [...d.save].length + [...d.recall].length + [...d.load].length
  assert(total(compact) < total(long) * 0.6, `${total(compact)} vs ${total(long)}`)
})
