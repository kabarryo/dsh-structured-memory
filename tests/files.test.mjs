import { test, assert, assertEqual } from './lib/harness.mjs'
import { normalizeFiles, mergeIntoSessionMemory } from '../index.js'

test('normalizeFiles accepts objects and bare strings, dedupes, and lets modified win', () => {
  const files = normalizeFiles([
    { path: 'index.js', action: 'read' },
    { path: 'index.js', action: 'modified' },
    ' search-index.js ',
    { path: '', action: 'modified' },
    { path: 'a/b.json' },
  ])
  assertEqual(files, [
    { path: 'index.js', action: 'modified' },
    { path: 'search-index.js', action: 'read' },
    { path: 'a/b.json', action: 'read' },
  ])
})

test('normalizeFiles caps the list at MAX_MEMORY_FILES paths', () => {
  const many = Array.from({ length: 60 }, (_, i) => `f${i}.js`)
  assertEqual(normalizeFiles(many).length, 50)
})

test('a repeated fact still records the new files (no content write)', () => {
  const doc = { sessionId: 's', memories: [] }
  mergeIntoSessionMemory(doc, 'fact one', 'general', [{ path: 'a.js', action: 'read' }])
  const outcome = mergeIntoSessionMemory(doc, 'fact one', 'general', [{ path: 'b.js', action: 'modified' }])
  assertEqual(outcome.created, false, 'content is already covered')
  assertEqual(outcome.filesChanged, true, 'but the file list is new')
  assertEqual(doc.memories.length, 1)
  assertEqual(doc.memories[0].files, [
    { path: 'a.js', action: 'read' },
    { path: 'b.js', action: 'modified' },
  ])
})

test('merging content unions the files and keeps the strongest action', () => {
  const doc = { sessionId: 's', memories: [] }
  mergeIntoSessionMemory(doc, 'first fact', 'general', [{ path: 'a.js', action: 'read' }])
  mergeIntoSessionMemory(doc, 'second fact', 'general', [{ path: 'a.js', action: 'modified' }])
  assertEqual(doc.memories[0].files, [{ path: 'a.js', action: 'modified' }])
})

test('collapseSessionMemories unions files from every absorbed memory', () => {
  const doc = {
    sessionId: 's',
    memories: [
      { id: 'm1', content: 'one', category: 'general', createdAt: 1, files: [{ path: 'a.js', action: 'read' }] },
      { id: 'm2', content: 'two', category: 'general', createdAt: 2, files: [{ path: 'b.js', action: 'modified' }] },
    ],
  }
  mergeIntoSessionMemory(doc, 'three', 'general', [])
  assertEqual(doc.memories.length, 1)
  assertEqual(doc.memories[0].files, [
    { path: 'a.js', action: 'read' },
    { path: 'b.js', action: 'modified' },
  ])
})

import { tempStore, memoryTools, fakeAgent } from './lib/harness.mjs'

test('save_memory records files, and recall finds the memory by path alone', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    const agent = fakeAgent('sess-e2e')

    // The path appears ONLY in `files`, never in the content — so a hit can only
    // come from the file column, which is the whole point of the feature.
    const saved = await tools.save_memory.execute({
      content: '注入重复已修复',
      trigger: 'decision',
      evidence: 'index.js:1178',
      category: 'bugfix',
      files: [{ path: 'index.js', action: 'modified' }],
    }, { agent })
    assertEqual(saved.stored, true)
    assertEqual(saved.fileCount, 1)

    const hit = await tools.recall_memory.execute({ query: 'index.js', limit: 5 }, { agent })
    assertEqual(hit.sessions.map((row) => row.sessionId), ['sess-e2e'])
    assertEqual(hit.sessions[0].memories[0].files, [{ path: 'index.js', action: 'modified' }])
  } finally {
    await store.dispose()
  }
})

test('a repeated save still adds the new file to the stored memory', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    const agent = fakeAgent('sess-dup')
    await tools.save_memory.execute({
      content: '同一结论', trigger: 'decision', evidence: 'index.js:1',
      files: [{ path: 'a.js', action: 'read' }],
    }, { agent })
    const again = await tools.save_memory.execute({
      content: '同一结论', trigger: 'decision', evidence: 'index.js:1',
      files: [{ path: 'b.js', action: 'modified' }],
    }, { agent })
    assertEqual(again.stored, false, 'content was already covered')
    const detail = await tools.recall_memory.execute({ scope: 'session', sessionId: 'sess-dup' }, { agent })
    assertEqual(detail.sessions[0].memories[0].files, [
      { path: 'a.js', action: 'read' },
      { path: 'b.js', action: 'modified' },
    ])
  } finally {
    await store.dispose()
  }
})

import { buildExportBundle, parseExportBundle, planImport } from '../index.js'

test('an export bundle round-trips files through import', () => {
  const doc = {
    sessionId: 's1',
    title: 'T',
    origin: null,
    memories: [{ id: 'm1', content: '内容', category: 'bugfix', createdAt: 1, files: [{ path: 'index.js', action: 'modified' }] }],
  }
  const bundle = buildExportBundle({
    version: 'test', profile: null, entries: [], sessions: [doc], options: {}, at: 1,
  })
  const parsed = parseExportBundle(JSON.stringify(bundle))
  assertEqual(parsed.ok, true)
  assertEqual(parsed.bundle.sessions[0].memories[0].files, [{ path: 'index.js', action: 'modified' }])

  const plan = planImport({
    bundle: parsed.bundle,
    targetProfile: { version: 1, updatedAt: null, sections: { identity: [], work: [], personal: [], technical: [], style: [] } },
    targetSessionIds: new Set(),
    onExisting: 'merge',
  })
  assertEqual(plan.sessions.map((row) => row.sessionId), ['s1'])
})

test('a /dream draft keeps the files of the memories it absorbed', async () => {
  const { evaluateSessionConsolidation } = await import('../index.js')
  const doc = {
    sessionId: 's',
    memories: [{ id: 'm1', content: '注入重复已修复', category: 'bugfix', createdAt: 1, files: [{ path: 'index.js', action: 'modified' }] }],
  }
  const evaluation = evaluateSessionConsolidation(doc, { content: '注入重复已修复', category: 'bugfix' })
  assertEqual(evaluation.next[0].files, [{ path: 'index.js', action: 'modified' }])
})
