import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  test, assert, assertEqual, tempStore, memoryTools, fakeAgent,
  bridgeRoutes, callRoute, readStoreFile,
} from './lib/harness.mjs'

const STORE = '/api/dsh-structured-memory-store'
const TRANSFER = '/api/dsh-structured-memory-transfer'

/** Two sessions in the store, plus the bridge routes, ready to drive. */
async function setup() {
  const store = await tempStore()
  const tools = await memoryTools(store.config)
  const agent = fakeAgent('s1')
  await tools.save_memory.execute({
    content: 'first session memory about index.js',
    trigger: 'user-request',
    keyPoint: 'first',
    category: 'bugfix',
    files: [{ path: 'index.js', action: 'modified' }],
  }, { agent })
  await tools.save_memory.execute({
    content: 'second session memory about docs',
    trigger: 'user-request',
    keyPoint: 'second',
    category: 'decision',
  }, { agent: fakeAgent('s2') })
  const routes = await bridgeRoutes(store.config)
  return { store, tools, routes }
}

const op = async (routes, ops) => callRoute(routes.get(STORE), {
  method: 'POST',
  url: `${STORE}?ops=1`,
  body: { ops },
})

test('both bridges are registered and refuse non-loopback callers', async () => {
  const { store, routes } = await setup()
  try {
    assert(routes.has(STORE), 'store bridge registered')
    assert(routes.has(TRANSFER), 'transfer bridge registered')

    const remote = await callRoute(routes.get(STORE), { method: 'GET', url: STORE, address: '10.0.0.7' })
    assertEqual(remote.status, 403)
    assertEqual(remote.json.code, 'loopback-only')

    const remoteTransfer = await callRoute(routes.get(TRANSFER), { method: 'GET', url: TRANSFER, address: '10.0.0.7' })
    assertEqual(remoteTransfer.status, 403)
  } finally {
    await store.dispose()
  }
})

test('GET returns the editor view: profile, index, injection price and limits', async () => {
  const { store, routes } = await setup()
  try {
    const view = await callRoute(routes.get(STORE), { method: 'GET', url: STORE })
    assertEqual(view.status, 200)
    assertEqual(view.json.ok, true)
    assertEqual(view.json.global.length, 2)
    assert(view.json.global.every((row) => row.linked === true), 'entries link to session files')
    assert(view.json.injection.total.bytes > 0)
    assert(view.json.injection.maxInjectBytes >= 1)
    assertEqual(view.json.stats.globalEntries, 2)
  } finally {
    await store.dispose()
  }
})

test('profile.replace writes the section, dedupes, and rejects overlong input', async () => {
  const { store, routes } = await setup()
  try {
    const ok = await op(routes, [{ op: 'profile.replace', section: 'identity', points: ['教师', '教师', '  '] }])
    assertEqual(ok.json.ok, true)
    assertEqual(ok.json.changed, 1)
    const profile = await readStoreFile(store.dir, 'profile.json')
    assertEqual(profile.sections.identity, ['教师'], 'deduped and trimmed')

    const overlong = await op(routes, [{ op: 'profile.replace', section: 'identity', points: ['x'.repeat(4001)] }])
    assertEqual(overlong.json.ok, false)
    assertEqual(overlong.json.code, 'rejected')
    assert(/4000/.test(overlong.json.message), overlong.json.message)

    const badSection = await op(routes, [{ op: 'profile.replace', section: 'nope', points: ['x'] }])
    assertEqual(badSection.json.ok, false)
    assertEqual(badSection.json.code, 'rejected')
  } finally {
    await store.dispose()
  }
})

test('global.update writes the title and category through to the session record', async () => {
  const { store, routes } = await setup()
  try {
    const view = await callRoute(routes.get(STORE), { method: 'GET', url: STORE })
    const target = view.json.global.find((row) => row.sessionId === 's1')

    const result = await op(routes, [{ op: 'global.update', id: target.id, title: '重命名后的标题', category: 'decision' }])
    assertEqual(result.json.ok, true)

    const doc = await readStoreFile(store.dir, 'sessions/s1.json')
    assertEqual(doc.title, '重命名后的标题')
    assertEqual(doc.memories[0].category, 'decision', 'the session record follows the entry')
    const entry = result.json.global.find((row) => row.sessionId === 's1')
    assertEqual(entry.title, '重命名后的标题')
    assertEqual(entry.category, 'decision')
  } finally {
    await store.dispose()
  }
})

test('global.remove refuses a linked entry and allows an orphan', async () => {
  const { store, routes } = await setup()
  try {
    const view = await callRoute(routes.get(STORE), { method: 'GET', url: STORE })
    const linked = view.json.global.find((row) => row.sessionId === 's1')
    const refused = await op(routes, [{ op: 'global.remove', id: linked.id }])
    assertEqual(refused.json.ok, false)
    assert(/一一对应/.test(refused.json.message), refused.json.message)

    // A hand-written orphan entry: index row with no session file behind it.
    const global = await readStoreFile(store.dir, 'global.json')
    global.push({ id: 'g-ghost', sessionId: 'ghost', title: 'Ghost', keyPoints: 'kp', category: 'general', lastActivity: 1 })
    await writeFile(join(store.dir, 'global.json'), JSON.stringify(global))

    const removed = await op(routes, [{ op: 'global.remove', id: 'g-ghost' }])
    assertEqual(removed.json.ok, true)
    assertEqual(removed.json.global.some((row) => row.id === 'g-ghost'), false)
  } finally {
    await store.dispose()
  }
})

test('memory.replace keeps id/createdAt/files, resets mergedCount, and reindexes by path', async () => {
  const { store, tools, routes } = await setup()
  try {
    const before = await readStoreFile(store.dir, 'sessions/s1.json')
    const original = before.memories[0]

    const result = await op(routes, [{
      op: 'memory.replace',
      sessionId: 's1',
      content: 'rewritten content with no path in it',
      category: 'bugfix',
    }])
    assertEqual(result.json.ok, true)

    const after = await readStoreFile(store.dir, 'sessions/s1.json')
    assertEqual(after.memories[0].id, original.id)
    assertEqual(after.memories[0].createdAt, original.createdAt)
    assertEqual(after.memories[0].mergedCount, 1)
    assertEqual(after.memories[0].files, [{ path: 'index.js', action: 'modified' }], 'file coordinates survive the edit')

    // The derived index must serve the new text AND still answer a path query.
    const agent = fakeAgent('probe')
    const byNewText = await tools.recall_memory.execute({ query: 'rewritten content' }, { agent })
    assertEqual(byNewText.sessions.map((row) => row.sessionId), ['s1'])
    const byPath = await tools.recall_memory.execute({ query: 'index.js' }, { agent })
    assertEqual(byPath.sessions.map((row) => row.sessionId), ['s1'], 'path recall survives a bridge rewrite')
    const byOldText = await tools.recall_memory.execute({ query: 'first session memory' }, { agent })
    assertEqual(byOldText.sessions.length, 0, 'the old text is gone from the index')
  } finally {
    await store.dispose()
  }
})

test('memory.remove deletes one memory and clears its search row', async () => {
  const { store, tools, routes } = await setup()
  try {
    const doc = await readStoreFile(store.dir, 'sessions/s2.json')
    const result = await op(routes, [{ op: 'memory.remove', sessionId: 's2', memoryId: doc.memories[0].id }])
    assertEqual(result.json.ok, true)

    const agent = fakeAgent('probe')
    const recalled = await tools.recall_memory.execute({ query: 'second session memory' }, { agent })
    assertEqual(recalled.sessions.length, 0)

    const missing = await op(routes, [{ op: 'memory.remove', sessionId: 's2', memoryId: 'nope' }])
    assertEqual(missing.json.ok, false)
    assert(/no memory/.test(missing.json.message), missing.json.message)
  } finally {
    await store.dispose()
  }
})

test('session.remove drops the file, the entry and the index together', async () => {
  const { store, tools, routes } = await setup()
  try {
    const result = await op(routes, [{ op: 'session.remove', sessionId: 's1' }])
    assertEqual(result.json.ok, true)
    assertEqual(result.json.global.some((row) => row.sessionId === 's1'), false)
    assertEqual(await readStoreFile(store.dir, 'sessions/s1.json'), null)

    const agent = fakeAgent('probe')
    const recalled = await tools.recall_memory.execute({ query: 'first session memory' }, { agent })
    assertEqual(recalled.sessions.length, 0)
  } finally {
    await store.dispose()
  }
})

test('session.collapse is a no-op on the single-memory shape', async () => {
  const { store, routes } = await setup()
  try {
    const before = await readStoreFile(store.dir, 'sessions/s1.json')
    const result = await op(routes, [{ op: 'session.collapse', sessionId: 's1' }])
    assertEqual(result.json.ok, true)
    assertEqual((await readStoreFile(store.dir, 'sessions/s1.json')).memories[0].content, before.memories[0].content)
  } finally {
    await store.dispose()
  }
})

test('an unknown op and an oversized body are refused with stable codes', async () => {
  const { store, routes } = await setup()
  try {
    const unknown = await op(routes, [{ op: 'memory.vanish', sessionId: 's1' }])
    assertEqual(unknown.json.ok, false)
    assertEqual(unknown.json.code, 'rejected')
    assert(/unknown operation/.test(unknown.json.message), unknown.json.message)

    const huge = await callRoute(routes.get(STORE), {
      method: 'POST',
      url: `${STORE}?ops=1`,
      body: 'x'.repeat(1024 * 1024 + 10),
    })
    assertEqual(huge.status, 400)
    assertEqual(huge.json.code, 'malformed-body')
  } finally {
    await store.dispose()
  }
})

test('config.set is refused when the settings service is unavailable', async () => {
  const { store, routes } = await setup()
  try {
    const refused = await op(routes, [{ op: 'config.set', field: 'injectLimit', value: 10 }])
    assertEqual(refused.json.ok, false)
    assertEqual(refused.json.code, 'rejected')
    assert(/settings service/.test(refused.json.message), refused.json.message)

    const badField = await op(routes, [{ op: 'config.set', field: 'memoryDir', value: 1 }])
    assertEqual(badField.json.ok, false)
    assert(/not editable/.test(badField.json.message), badField.json.message)

    const badValue = await op(routes, [{ op: 'config.set', field: 'injectLimit', value: 0 }])
    assertEqual(badValue.json.ok, false)
  } finally {
    await store.dispose()
  }
})

test('config.set writes whitelisted fields through the settings service', async () => {
  const store = await tempStore()
  try {
    const calls = []
    const tools = await memoryTools(store.config)
    await tools.save_memory.execute({ content: 'seed', trigger: 'user-request' }, { agent: fakeAgent('s1') })
    const routes = await bridgeRoutes(store.config, {
      settings: {
        mutate: async (pluginName, writes) => { calls.push({ pluginName, writes }) },
      },
    })

    const result = await op(routes, [{ op: 'config.set', field: 'injectLimit', value: 7 }])
    assertEqual(result.json.ok, true)
    assertEqual(calls.length, 1)
    assertEqual(calls[0].pluginName, 'dsh-structured-memory')
    assertEqual(calls[0].writes[0], { op: 'set', path: ['injectLimit'], value: 7 })
    assertEqual(result.json.injection.injectLimit, 7, 'the response previews the new value')
  } finally {
    await store.dispose()
  }
})

test('doctor.repair heals a missing entry and drops an orphan', async () => {
  const { store, routes } = await setup()
  try {
    // Missing entry: a session file with no index row.
    const global = await readStoreFile(store.dir, 'global.json')
    const trimmed = global.filter((row) => row.sessionId !== 's2')
    trimmed.push({ id: 'g-orphan', sessionId: 'gone', title: 'Gone', keyPoints: 'kp', category: 'general', lastActivity: 1 })
    await writeFile(join(store.dir, 'global.json'), JSON.stringify(trimmed))

    const pre = await callRoute(routes.get(STORE), { method: 'GET', url: `${STORE}?doctor=1` })
    assertEqual(pre.json.ok, true)
    assertEqual(pre.json.missingEntries.map((row) => row.sessionId), ['s2'])
    assertEqual(pre.json.orphanEntries.map((row) => row.id), ['g-orphan'])

    const repaired = await op(routes, [{ op: 'doctor.repair' }])
    assertEqual(repaired.json.ok, true)
    assert(repaired.json.actions.some((line) => line.includes('补建条目')), JSON.stringify(repaired.json.actions))
    assert(repaired.json.actions.some((line) => line.includes('孤儿条目')), JSON.stringify(repaired.json.actions))

    const post = await callRoute(routes.get(STORE), { method: 'GET', url: `${STORE}?doctor=1` })
    assertEqual(post.json.missingEntries.length, 0)
    assertEqual(post.json.orphanEntries.length, 0)
  } finally {
    await store.dispose()
  }
})

test('the editor can list sessions and read one session detail', async () => {
  const { store, routes } = await setup()
  try {
    const list = await callRoute(routes.get(STORE), { method: 'GET', url: `${STORE}?sessions=1` })
    assertEqual(list.json.ok, true)
    assertEqual(list.json.sessions.map((row) => row.sessionId).sort(), ['s1', 's2'])

    const detail = await callRoute(routes.get(STORE), { method: 'GET', url: `${STORE}?session=s1` })
    assertEqual(detail.json.ok, true)
    assertEqual(detail.json.memories.length, 1)
    assertEqual(detail.json.memories[0].files, [{ path: 'index.js', action: 'modified' }])

    const missing = await callRoute(routes.get(STORE), { method: 'GET', url: `${STORE}?session=nope` })
    assertEqual(missing.json.ok, false)
    assertEqual(missing.json.code, 'no-session')
  } finally {
    await store.dispose()
  }
})
