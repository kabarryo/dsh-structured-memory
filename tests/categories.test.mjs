import { test, assert, assertEqual } from './lib/harness.mjs'
import {
  normalizeCategory,
  MEMORY_CATEGORIES,
  evaluateSessionConsolidation,
  buildExportBundle,
  draftToStore,
} from '../index.js'

test('the vocabulary is exactly five values', () => {
  assertEqual(MEMORY_CATEGORIES, ['decision', 'bugfix', 'security', 'preference', 'general'])
})

test('aliases (English and Chinese) normalize onto the vocabulary', () => {
  assertEqual(normalizeCategory(' bugfix '), 'bugfix')
  assertEqual(normalizeCategory('修复'), 'bugfix')
  assertEqual(normalizeCategory('决策'), 'decision')
  assertEqual(normalizeCategory('安全'), 'security')
  assertEqual(normalizeCategory('风格'), 'preference')
  assertEqual(normalizeCategory('whatever'), 'general')
  assertEqual(normalizeCategory(''), 'general')
  assertEqual(normalizeCategory(undefined, 'security'), 'security', 'fallback is honoured')
})

test('a session holding a security fact keeps the security type after synthesis', () => {
  const doc = {
    sessionId: 's',
    memories: [{ id: 'm1', content: '轮换脚本 ops/rotate.md，token 前缀 sk- 不得入库', category: 'security', createdAt: 1 }],
  }
  const evaluation = evaluateSessionConsolidation(doc, { content: '轮换脚本 ops/rotate.md，token 前缀 sk- 不得入库', category: 'preference' })
  assertEqual(evaluation.next[0].category, 'security')
})

test('dropping a security anchor is reported so apply can refuse', () => {
  const doc = {
    sessionId: 's',
    memories: [{ id: 'm1', content: '轮换脚本 ops/rotate.md，token 前缀 sk- 不得入库', category: 'security', createdAt: 1 }],
  }
  const evaluation = evaluateSessionConsolidation(doc, { content: '轮换脚本已就绪', category: 'security' })
  assert(evaluation.lostSecurity.includes('ops/rotate.md'), JSON.stringify(evaluation.lostSecurity))
})

test('a non-security session is not gated by lostSecurity', () => {
  const doc = { sessionId: 's', memories: [{ id: 'm1', content: '见 ops/rotate.md', category: 'decision', createdAt: 1 }] }
  const evaluation = evaluateSessionConsolidation(doc, { content: '已决定', category: 'decision' })
  assertEqual(evaluation.lostSecurity.length, 0)
})

test('draftToStore normalizes a model label but keeps an operator label', () => {
  const entries = [
    { id: 'g1', sessionId: 's1', title: 'A', keyPoints: 'kp', category: '教务', lastActivity: 1 },
  ]
  const sections = { identity: [], work: [], personal: [], technical: [], style: [] }
  const omitted = draftToStore(sections, entries, { global: [{ fromIds: ['g1'], title: 'A', keyPoints: 'kp' }] })
  assertEqual(omitted.entries[0].category, '教务', 'operator label survives an omitted category')

  const relabeled = draftToStore(sections, entries, { global: [{ fromIds: ['g1'], title: 'A', keyPoints: 'kp', category: '修复' }] })
  assertEqual(relabeled.entries[0].category, 'bugfix', 'model alias is normalized')
})

test('export never rewrites a stored category', () => {
  const bundle = buildExportBundle({
    version: 'test', profile: null, entries: [], at: 1, options: {},
    sessions: [{ sessionId: 's', title: null, origin: null, memories: [{ id: 'm', content: 'x', category: '教务', createdAt: 1 }] }],
  })
  assertEqual(bundle.sessions[0].memories[0].category, '教务')
})
