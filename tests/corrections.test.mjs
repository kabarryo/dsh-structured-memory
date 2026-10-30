import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  test, assert, assertEqual, tempStore, memoryTools, fakeAgent, readStoreFile,
} from './lib/harness.mjs'

const save = (tools, args, agent) => tools.save_memory.execute(args, { agent })

test('a correction removes the stale line and appends the corrected fact', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    const agent = fakeAgent('c1')
    await save(tools, { content: '端口是 8080\n其余事实保持不变', trigger: 'user-request' }, agent)
    const before = await readStoreFile(store.dir, 'sessions/c1.json')

    const result = await save(tools, {
      content: '端口是 3000',
      trigger: 'correction',
      evidence: '用户说：不是 8080，是 3000',
      supersedes: ['端口是 8080'],
    }, agent)

    assertEqual(result.stored, true)
    assertEqual(result.corrected, true)
    assertEqual(result.removedLines, 1)
    assertEqual(result.sessionId, 'c1')

    const doc = await readStoreFile(store.dir, 'sessions/c1.json')
    assert(!doc.memories[0].content.includes('8080'), doc.memories[0].content)
    assert(doc.memories[0].content.includes('端口是 3000'))
    assert(doc.memories[0].content.includes('其余事实保持不变'), 'untouched facts survive')
    assertEqual(doc.memories[0].id, before.memories[0].id)
    assertEqual(doc.memories[0].createdAt, before.memories[0].createdAt)
    assertEqual(doc.memories[0].correctedCount, 1)
    assert(Number.isFinite(doc.memories[0].correctedAt))
  } finally {
    await store.dispose()
  }
})

test('several stale fragments can be superseded at once', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    const agent = fakeAgent('c2')
    await save(tools, { content: '事实A\n事实B\n事实C', trigger: 'user-request' }, agent)
    const result = await save(tools, {
      content: '事实D', trigger: 'correction', evidence: '用户纠正 A 与 C', supersedes: ['事实A', '事实C'],
    }, agent)
    assertEqual(result.removedLines, 2)
    const doc = await readStoreFile(store.dir, 'sessions/c2.json')
    assertEqual(doc.memories[0].content.includes('事实A'), false)
    assertEqual(doc.memories[0].content.includes('事实C'), false)
    assert(doc.memories[0].content.includes('事实B'))
    assert(doc.memories[0].content.includes('事实D'))
  } finally {
    await store.dispose()
  }
})

test('matching ignores case, spacing and punctuation', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    const agent = fakeAgent('c3')
    await save(tools, { content: 'Port  is 8080.\n另一条', trigger: 'user-request' }, agent)
    const result = await save(tools, {
      content: 'port is 3000', trigger: 'correction', evidence: '纠正端口', supersedes: ['port is 8080'],
    }, agent)
    assertEqual(result.removedLines, 1)
    const doc = await readStoreFile(store.dir, 'sessions/c3.json')
    assert(!doc.memories[0].content.toLowerCase().includes('8080'))
    assert(doc.memories[0].content.includes('port is 3000'))
  } finally {
    await store.dispose()
  }
})

test('a fragment that matches nothing is refused and the store is untouched', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    const agent = fakeAgent('c4')
    await save(tools, { content: '真实存在的旧事实', trigger: 'user-request' }, agent)
    const before = await readFile(join(store.dir, 'sessions/c4.json'), 'utf8')

    let error = null
    try {
      await save(tools, {
        content: '新事实', trigger: 'correction', evidence: '用户纠正', supersedes: ['根本不存在的旧事实'],
      }, agent)
    } catch (caught) {
      error = caught
    }
    assert(error !== null, 'a miss must throw')
    assert(/no stored line matched/.test(error.message), error.message)
    assert(/recall_memory/.test(error.message), 'the error tells the model how to find the exact text')
    assertEqual(await readFile(join(store.dir, 'sessions/c4.json'), 'utf8'), before, 'nothing was written')
  } finally {
    await store.dispose()
  }
})

test('trigger=correction without supersedes is refused', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    let error = null
    try {
      await save(tools, { content: 'x', trigger: 'correction', evidence: '纠正' }, fakeAgent('c5'))
    } catch (caught) {
      error = caught
    }
    assert(error !== null)
    assert(/supersedes/.test(error.message), error.message)
  } finally {
    await store.dispose()
  }
})

test('sessionId is only allowed for corrections', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    let error = null
    try {
      await save(tools, { content: 'x', trigger: 'user-request', sessionId: 'other' }, fakeAgent('c6'))
    } catch (caught) {
      error = caught
    }
    assert(error !== null)
    assert(/only.*correction|correction only/i.test(error.message), error.message)
  } finally {
    await store.dispose()
  }
})

test('a past session can be corrected from another session, entry and index follow', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    await save(tools, { content: '部署端口是 8080\n部署目录 /srv/app', trigger: 'user-request', keyPoint: '部署端口 8080' }, fakeAgent('old'))

    const result = await save(tools, {
      content: '部署端口是 3000',
      trigger: 'correction',
      evidence: '用户：端口已改为 3000',
      supersedes: ['部署端口是 8080'],
      sessionId: 'old',
      keyPoint: '部署端口 3000',
    }, fakeAgent('new'))

    assertEqual(result.corrected, true)
    assertEqual(result.sessionId, 'old', 'the answer names the corrected session')

    const oldDoc = await readStoreFile(store.dir, 'sessions/old.json')
    assert(!oldDoc.memories[0].content.includes('8080'))
    assert(oldDoc.memories[0].content.includes('3000'))
    assert(oldDoc.memories[0].content.includes('/srv/app'), 'unrelated coordinates survive')

    const global = await readStoreFile(store.dir, 'global.json')
    const entry = global.find((row) => row.sessionId === 'old')
    assertEqual(entry.keyPoints, '部署端口 3000', 'the index entry follows the correction')

    const stale = await tools.recall_memory.execute({ query: '8080' }, { agent: fakeAgent('probe') })
    assertEqual(stale.sessions.length, 0, 'the stale text is gone from the index')
    const fresh = await tools.recall_memory.execute({ query: '3000' }, { agent: fakeAgent('probe') })
    assertEqual(fresh.sessions.map((row) => row.sessionId), ['old'])

    assertEqual(await readStoreFile(store.dir, 'sessions/new.json'), null, 'the correcting session gets no memory of its own')
  } finally {
    await store.dispose()
  }
})

test('correcting a session that has no memory is refused', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    let error = null
    try {
      await save(tools, {
        content: 'x', trigger: 'correction', evidence: '纠正', supersedes: ['旧事实'], sessionId: 'ghost',
      }, fakeAgent('c8'))
    } catch (caught) {
      error = caught
    }
    assert(error !== null)
    assert(/no memory|no stored memory/i.test(error.message), error.message)
  } finally {
    await store.dispose()
  }
})

test('delegated subagents cannot correct memories either', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    await save(tools, { content: '父会话旧事实', trigger: 'user-request' }, fakeAgent('parent'))
    const child = { id: 'child', session: { header: { origin: 'subagent' } } }
    let error = null
    try {
      await save(tools, {
        content: '新事实', trigger: 'correction', evidence: '纠正', supersedes: ['父会话旧事实'], sessionId: 'parent',
      }, child)
    } catch (caught) {
      error = caught
    }
    assert(error !== null)
    assert(/read-only/.test(error.message), error.message)
  } finally {
    await store.dispose()
  }
})

test('a correction snapshots the old memory and appends to the corrections log', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    const agent = fakeAgent('c10')
    await save(tools, { content: '旧端口 8080', trigger: 'user-request' }, agent)
    await save(tools, {
      content: '新端口 3000', trigger: 'correction', evidence: '用户确认改成 3000', supersedes: ['旧端口 8080'],
    }, agent)

    const dir = join(store.dir, 'memory-backup', 'corrections')
    const snaps = (await readdir(dir)).filter((name) => name.includes('c10'))
    assertEqual(snaps.length, 1, JSON.stringify(snaps))
    const snapshot = JSON.parse(await readFile(join(dir, snaps[0]), 'utf8'))
    assert(snapshot.memories[0].content.includes('旧端口 8080'), 'the snapshot holds the pre-correction text')

    const log = await readStoreFile(store.dir, 'corrections-log.json')
    assertEqual(log.length, 1)
    assertEqual(log[0].sessionId, 'c10')
    assertEqual(log[0].removedLines, 1)
    assert(/3000/.test(log[0].evidence), log[0].evidence)
    assert(log[0].snapshot.includes('c10'))
  } finally {
    await store.dispose()
  }
})

test('an oversized correction is refused atomically', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    const agent = fakeAgent('c11')
    // Two lines: the short one is superseded, the long one has to survive, so
    // the replacement still overflows the 16,000-character ceiling.
    await save(tools, { content: `${'a'.repeat(100)}\n${'c'.repeat(15800)}`, trigger: 'user-request' }, agent)
    const before = await readFile(join(store.dir, 'sessions/c11.json'), 'utf8')

    let error = null
    try {
      await save(tools, {
        content: 'b'.repeat(5000), trigger: 'correction', evidence: '纠正', supersedes: ['a'.repeat(100)],
      }, agent)
    } catch (caught) {
      error = caught
    }
    assert(error !== null)
    assert(/16000/.test(error.message), error.message)
    assertEqual(await readFile(join(store.dir, 'sessions/c11.json'), 'utf8'), before, 'no partial write')
  } finally {
    await store.dispose()
  }
})

test('private spans are scrubbed from a correction too', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    const agent = fakeAgent('c12')
    await save(tools, { content: '旧结论', trigger: 'user-request' }, agent)
    const result = await save(tools, {
      content: '新结论 <private>sk-hidden</private> 尾巴',
      trigger: 'correction',
      evidence: '用户纠正结论',
      supersedes: ['旧结论'],
    }, agent)
    assertEqual(result.redacted >= 1, true)
    const doc = await readStoreFile(store.dir, 'sessions/c12.json')
    assert(!doc.memories[0].content.includes('sk-hidden'))
    assert(doc.memories[0].content.includes('新结论'))
  } finally {
    await store.dispose()
  }
})

test('correcting to a fact the memory already holds still removes the stale line', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    const agent = fakeAgent('c13')
    await save(tools, { content: '端口是 8080\n端口是 3000', trigger: 'user-request' }, agent)
    const result = await save(tools, {
      content: '端口是 3000', trigger: 'correction', evidence: '以 3000 为准', supersedes: ['8080'],
    }, agent)
    assertEqual(result.stored, true)
    assertEqual(result.removedLines, 1)
    const doc = await readStoreFile(store.dir, 'sessions/c13.json')
    assert(!doc.memories[0].content.includes('8080'))
    assertEqual(doc.memories[0].content.split('3000').length - 1, 1, 'no duplicated corrected fact')
  } finally {
    await store.dispose()
  }
})

test('repeated corrections increment correctedCount and carry the title through', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    const agent = fakeAgent('c14')
    await save(tools, { content: '版本 1', trigger: 'user-request' }, agent)
    await save(tools, { content: '版本 2', trigger: 'correction', evidence: '升到 2', supersedes: ['版本 1'], title: '版本记录' }, agent)
    await save(tools, { content: '版本 3', trigger: 'correction', evidence: '升到 3', supersedes: ['版本 2'] }, agent)

    const doc = await readStoreFile(store.dir, 'sessions/c14.json')
    assertEqual(doc.memories[0].correctedCount, 2)
    assertEqual(doc.title, '版本记录', 'the title given on a correction lands on the session record too')

    const global = await readStoreFile(store.dir, 'global.json')
    const entry = global.find((row) => row.sessionId === 'c14')
    assertEqual(entry.title, '版本记录', 'entry and record agree, so doctor stays clean')
  } finally {
    await store.dispose()
  }
})
