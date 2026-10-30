import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, assert, assertEqual, tempStore, memoryTools, fakeAgent } from './lib/harness.mjs'
import { stripPointersFromKeyPoint, MAX_MEMORY_FILES } from '../index.js'

const sessionFiles = async (dir) => {
  try {
    return (await readdir(join(dir, 'sessions'))).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
}
const readDoc = async (dir, id) => JSON.parse(await readFile(join(dir, 'sessions', `${id}.json`), 'utf8'))
const readGlobal = async (dir) => JSON.parse(await readFile(join(dir, 'global.json'), 'utf8'))

test('the single memory is capped at 16,000 characters and refuses the write instead of truncating', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    const agent = fakeAgent('cap')
    const first = 'a'.repeat(7999)
    const second = 'b'.repeat(8000)
    await tools.save_memory.execute({ content: first, trigger: 'user-request' }, { agent })
    const before = await readDoc(store.dir, 'cap')

    const exact = await tools.save_memory.execute({ content: second, trigger: 'user-request' }, { agent })
    assertEqual(exact.stored, true, '16,000 exactly still fits')
    const after = await readDoc(store.dir, 'cap')
    assertEqual([...after.memories[0].content].length, 16000)

    const overflowing = await tools.save_memory.execute({ content: 'c'.repeat(10), trigger: 'user-request' }, { agent })
    assertEqual(overflowing.stored, false)
    assert(overflowing.reason.includes('16000'), overflowing.reason)
    const unchanged = await readDoc(store.dir, 'cap')
    assertEqual(unchanged.memories[0].content, after.memories[0].content, 'the file is untouched on overflow')
  } finally {
    await store.dispose()
  }
})

test('id and createdAt survive every rewrite, while mergedCount advances', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    const agent = fakeAgent('ids')
    const first = await tools.save_memory.execute({ content: 'fact one', trigger: 'user-request' }, { agent })
    const created = await readDoc(store.dir, 'ids')
    assertEqual(created.memories[0].id, first.id)
    assertEqual(created.memories[0].mergedCount, 1)

    await tools.save_memory.execute({ content: 'fact two', trigger: 'user-request' }, { agent })
    await tools.save_memory.execute({ content: 'fact three', trigger: 'user-request' }, { agent })
    const grown = await readDoc(store.dir, 'ids')
    assertEqual(grown.memories.length, 1, 'still one memory')
    assertEqual(grown.memories[0].id, first.id, 'id is stable')
    assertEqual(grown.memories[0].createdAt, created.memories[0].createdAt, 'createdAt is stable')
    assertEqual(grown.memories[0].mergedCount, 3)
    assert(grown.memories[0].updatedAt >= grown.memories[0].createdAt)
  } finally {
    await store.dispose()
  }
})

test('a duplicate save leaves the file byte-identical (idempotency)', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    const agent = fakeAgent('idem')
    await tools.save_memory.execute({ content: 'no new facts here', trigger: 'user-request' }, { agent })
    const before = await readFile(join(store.dir, 'sessions', 'idem.json'), 'utf8')

    const again = await tools.save_memory.execute({ content: 'no new facts here', trigger: 'user-request' }, { agent })
    assertEqual(again.stored, false)
    assert(again.reason.includes('already contained'), again.reason)
    const after = await readFile(join(store.dir, 'sessions', 'idem.json'), 'utf8')
    assertEqual(after, before, 'nothing was rewritten')
  } finally {
    await store.dispose()
  }
})

test('a legacy multi-memory file is folded into one memory on save, keeping the first id', async () => {
  const store = await tempStore()
  try {
    await mkdir(join(store.dir, 'sessions'), { recursive: true })
    await writeFile(join(store.dir, 'sessions', 'legacy.json'), JSON.stringify({
      sessionId: 'legacy',
      title: 'Legacy',
      memories: [
        { id: 'm-old-1', content: 'alpha fact', category: 'general', createdAt: 100 },
        { id: 'm-old-2', content: 'alpha   fact', category: 'general', createdAt: 200 },
        { id: 'm-old-3', content: 'beta fact', category: 'bugfix', createdAt: 300 },
      ],
    }))
    const tools = await memoryTools(store.config)
    await tools.save_memory.execute({ content: 'gamma fact', trigger: 'user-request' }, { agent: fakeAgent('legacy') })
    const doc = await readDoc(store.dir, 'legacy')
    assertEqual(doc.memories.length, 1, 'folded to one')
    assertEqual(doc.memories[0].id, 'm-old-1')
    assertEqual(doc.memories[0].mergedCount, 4, '3 absorbed on fold + 1 new merge')
    assertEqual(doc.memories[0].category, 'bugfix', 'the newest category survives')
    assertEqual(doc.memories[0].content.includes('gamma fact'), true)
    assertEqual(doc.memories[0].content.split('alpha').length - 1, 1, 'the CSS/whitespace twin was deduped')
  } finally {
    await store.dispose()
  }
})

test('one global entry per session, refreshed in place rather than duplicated', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    const agent = fakeAgent('global')
    await tools.save_memory.execute({ content: 'first', trigger: 'user-request', keyPoint: 'kp one', category: 'decision' }, { agent })
    await tools.save_memory.execute({ content: 'second', trigger: 'user-request', keyPoint: 'kp two', category: 'bugfix' }, { agent })
    const entries = await readGlobal(store.dir)
    assertEqual(entries.length, 1)
    assertEqual(entries[0].sessionId, 'global')
    assertEqual(entries[0].keyPoints, 'kp two')
    assertEqual(entries[0].category, 'bugfix')
    assertEqual(entries[0].lastActivity > 0, true)
  } finally {
    await store.dispose()
  }
})

test('keyPoint is capped at 50 chars, or 100 when it carries a critical token', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    // Words, not one long run: a 16+ character alphanumeric run is itself a
    // "critical token" (hash/id-shaped) and would earn the relaxed cap.
    const plain = await tools.save_memory.execute({
      content: 'content',
      trigger: 'user-request',
      keyPoint: 'word '.repeat(20),
    }, { agent: fakeAgent('kp-plain') })
    assert([...plain.globalKeyPoint].length <= 50, `plain cap: ${[...plain.globalKeyPoint].length}`)
    assert(plain.globalKeyPoint.endsWith('…'), plain.globalKeyPoint)

    const critical = await tools.save_memory.execute({
      content: 'content',
      trigger: 'user-request',
      keyPoint: `example.com ${'word '.repeat(20)}`,
    }, { agent: fakeAgent('kp-critical') })
    const criticalLength = [...critical.globalKeyPoint].length
    assert(criticalLength > 50 && criticalLength <= 100, `critical cap: ${criticalLength}`)
    assert(critical.globalKeyPoint.startsWith('example.com'), critical.globalKeyPoint)
  } finally {
    await store.dispose()
  }
})

test('keyPoint drops document pointers instead of spending its budget on them', () => {
  assertEqual(stripPointersFromKeyPoint('结论见 /Users/ryo/docs/plan.md'), '结论')
  assertEqual(stripPointersFromKeyPoint('细节见 UPGRADE.md'), '')
  assert(!stripPointersFromKeyPoint('记忆不足以解决问题时读取 /Users/x/过程文档').includes('/Users/'))
})

test('the trigger protocol rejects an unknown trigger and demands evidence only where it matters', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    const agent = fakeAgent('triggers')

    let unknown = null
    try {
      await tools.save_memory.execute({ content: 'x', trigger: 'worth-remembering' }, { agent })
    } catch (error) {
      unknown = error
    }
    assert(unknown !== null)
    assert(/user-request \| acceptance \| decision \| correction/.test(unknown.message), unknown.message)

    let noEvidence = null
    try {
      await tools.save_memory.execute({ content: 'x', trigger: 'decision' }, { agent })
    } catch (error) {
      noEvidence = error
    }
    assert(noEvidence !== null)
    assert(/requires evidence/.test(noEvidence.message), noEvidence.message)

    const requested = await tools.save_memory.execute({ content: 'y', trigger: 'user-request' }, { agent })
    assertEqual(requested.stored, true, 'an explicit user request needs no evidence')

    const accepted = await tools.save_memory.execute({ content: 'z', trigger: 'acceptance', evidence: '可以了' }, { agent })
    assertEqual(accepted.stored, true)
  } finally {
    await store.dispose()
  }
})

test('delegated subagents cannot save or forget, but can recall', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    await tools.save_memory.execute({ content: 'parent fact', trigger: 'user-request' }, { agent: fakeAgent('parent') })
    const child = { id: 'child', session: { header: { origin: 'subagent' } } }

    let saveError = null
    try {
      await tools.save_memory.execute({ content: 'child fact', trigger: 'user-request' }, { agent: child })
    } catch (error) {
      saveError = error
    }
    assert(saveError !== null && /read-only/.test(saveError.message), String(saveError?.message))

    let forgetError = null
    try {
      await tools.forget_memory.execute({ sessionId: 'parent' }, { agent: child })
    } catch (error) {
      forgetError = error
    }
    assert(forgetError !== null && /read-only/.test(forgetError.message), String(forgetError?.message))

    const recalled = await tools.recall_memory.execute({ query: 'parent fact' }, { agent: child })
    assertEqual(recalled.sessions.map((row) => row.sessionId), ['parent'], 'reads stay available')
  } finally {
    await store.dispose()
  }
})

test('forget by sessionId removes the file, the global entry and the search row', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    const agent = fakeAgent('doomed')
    await tools.save_memory.execute({ content: 'to be forgotten', trigger: 'user-request' }, { agent })
    const result = await tools.forget_memory.execute({ sessionId: 'doomed' }, { agent })
    assertEqual(result.removed, true)
    assertEqual(result.total, 0, 'the global entry is gone')
    assertEqual((await sessionFiles(store.dir)).includes('doomed.json'), false, 'the file is renamed away')
    assertEqual((await readGlobal(store.dir)).length, 0)
    const recalled = await tools.recall_memory.execute({ query: 'forgotten' }, { agent })
    assertEqual(recalled.sessions.length, 0, 'no search ghost')
  } finally {
    await store.dispose()
  }
})

test('forget by id drops the memory and its now-empty session entry', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    const agent = fakeAgent('one-id')
    const saved = await tools.save_memory.execute({ content: 'single fact', trigger: 'user-request' }, { agent })
    const result = await tools.forget_memory.execute({ id: saved.id }, { agent })
    assertEqual(result.removed, true)
    assertEqual(result.total, 0)
    const recalled = await tools.recall_memory.execute({ limit: 10 }, { agent })
    assertEqual(recalled.sessions.length, 0)
  } finally {
    await store.dispose()
  }
})

test('the file cap is a hard ceiling (MAX_MEMORY_FILES)', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    const files = Array.from({ length: 80 }, (_, i) => ({ path: `f${i}.js`, action: 'read' }))
    await tools.save_memory.execute({ content: 'many files', trigger: 'user-request', files }, { agent: fakeAgent('files-cap') })
    const doc = await readDoc(store.dir, 'files-cap')
    assertEqual(doc.memories[0].files.length, MAX_MEMORY_FILES)
  } finally {
    await store.dispose()
  }
})
