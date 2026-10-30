import { test, assert, assertEqual } from './lib/harness.mjs'
import { mergeIntoSessionMemory } from '../index.js'

test('the plugin module loads outside DSH and exposes the pure contracts', () => {
  assert(typeof mergeIntoSessionMemory === 'function', 'mergeIntoSessionMemory is exported')
})

test('a second save folds into the ONE memory of the session', () => {
  const doc = { sessionId: 's1', memories: [] }
  const first = mergeIntoSessionMemory(doc, 'alpha fact', 'general')
  assertEqual(first.created, true, 'first save creates the single memory')
  const second = mergeIntoSessionMemory(doc, 'beta fact', 'general')
  assertEqual(second.created, false, 'second save merges')
  assertEqual(doc.memories.length, 1, 'one memory per session')
  assert(doc.memories[0].content.includes('alpha fact'))
  assert(doc.memories[0].content.includes('beta fact'))
})
