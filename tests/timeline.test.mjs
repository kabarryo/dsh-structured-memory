import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, assertEqual, tempStore, memoryTools } from './lib/harness.mjs'
import { buildTimeline } from '../index.js'

async function seed(store) {
  const sessions = [
    { id: 's1', at: 1000 }, { id: 's2', at: 2000 }, { id: 's3', at: 3000 },
    { id: 's4', at: 4000 }, { id: 's5', at: 5000 },
  ]
  await mkdir(join(store.dir, 'sessions'), { recursive: true })
  for (const session of sessions) {
    await writeFile(join(store.dir, 'sessions', `${session.id}.json`), JSON.stringify({
      sessionId: session.id,
      title: session.id.toUpperCase(),
      updatedAt: session.at,
      memories: [{
        id: `m-${session.id}`,
        content: `memory ${session.id}`,
        category: 'general',
        createdAt: session.at,
        files: [{ path: `${session.id}.js`, action: 'modified' }],
      }],
    }))
  }
  await writeFile(join(store.dir, 'global.json'), JSON.stringify(sessions.map((session) => ({
    id: `g-${session.id}`,
    sessionId: session.id,
    title: session.id.toUpperCase(),
    keyPoints: `kp ${session.id}`,
    category: 'general',
    lastActivity: session.at,
  }))))
}

test('timeline returns the window around an anchor, newest first', async () => {
  const store = await tempStore()
  try {
    await seed(store)
    const result = await buildTimeline(store.config, { anchorSessionId: 's3', limit: 3 })
    assertEqual(result.anchorFound, true)
    assertEqual(result.timeline.map((row) => row.sessionId), ['s4', 's3', 's2'])
    assertEqual(result.timeline.map((row) => row.anchor), [false, true, false])
    assertEqual(result.timeline[1].files, 1)
    assertEqual(result.timeline[1].keyPoint, 'kp s3')
  } finally {
    await store.dispose()
  }
})

test('without an anchor the most recent window is returned', async () => {
  const store = await tempStore()
  try {
    await seed(store)
    const result = await buildTimeline(store.config, { limit: 2 })
    assertEqual(result.timeline.map((row) => row.sessionId), ['s5', 's4'])
    assertEqual(result.anchorFound, true)
  } finally {
    await store.dispose()
  }
})

test('a missing anchor falls back to the newest window and says so', async () => {
  const store = await tempStore()
  try {
    await seed(store)
    const result = await buildTimeline(store.config, { anchorSessionId: 'nope', limit: 2 })
    assertEqual(result.anchorFound, false)
    assertEqual(result.timeline.map((row) => row.sessionId), ['s5', 's4'])
  } finally {
    await store.dispose()
  }
})

test('a session with a file but no index entry still appears (linked:false)', async () => {
  const store = await tempStore()
  try {
    await seed(store)
    await writeFile(join(store.dir, 'sessions', 'orphan.json'), JSON.stringify({
      sessionId: 'orphan', title: 'ORPHAN', updatedAt: 9000,
      memories: [{ id: 'm-o', content: 'orphan memory', category: 'general', createdAt: 9000 }],
    }))
    const result = await buildTimeline(store.config, { limit: 1 })
    assertEqual(result.timeline[0].sessionId, 'orphan')
    assertEqual(result.timeline[0].linked, false)
  } finally {
    await store.dispose()
  }
})

test('scope=timeline routes recall_memory to the timeline builder', async () => {
  const store = await tempStore()
  try {
    await seed(store)
    const tools = await memoryTools(store.config)
    const result = await tools.recall_memory.execute({ scope: 'timeline', sessionId: 's3', limit: 3 }, { agent: { id: 's3', session: { header: {} } } })
    assertEqual(result.anchorFound, true)
    assertEqual(result.timeline.map((row) => row.sessionId), ['s4', 's3', 's2'])
    assertEqual(result.timeline.map((row) => row.anchor), [false, true, false])
  } finally {
    await store.dispose()
  }
})

test('the timeline scope does not leak the profile/global/session payloads', async () => {
  const store = await tempStore()
  try {
    await seed(store)
    const tools = await memoryTools(store.config)
    const result = await tools.recall_memory.execute({ scope: 'timeline', limit: 2 }, { agent: { id: 's', session: { header: {} } } })
    assertEqual(result.global, undefined, 'no global rows in a timeline answer')
    assertEqual(result.sessions, undefined, 'no session rows in a timeline answer')
    assertEqual(result.timeline.length, 2)
  } finally {
    await store.dispose()
  }
})
