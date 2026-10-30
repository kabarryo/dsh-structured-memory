import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, assert, assertEqual, tempStore } from './lib/harness.mjs'
import { openSearchIndex } from '../search-index.js'

test('a legacy index without the files column is dropped and rebuilt, not crashed', async () => {
  const store = await tempStore()
  try {
    const sessions = join(store.dir, 'sessions')
    await mkdir(sessions, { recursive: true })
    await writeFile(join(sessions, 's1.json'), JSON.stringify({
      sessionId: 's1',
      memories: [{
        id: 'm1',
        content: 'alpha beta gamma',
        category: 'general',
        createdAt: 1,
        files: [{ path: 'x.js', action: 'modified' }],
      }],
    }))

    // Simulate the pre-v2.20 derived index: no `files` column anywhere.
    const { DatabaseSync } = await import('node:sqlite')
    const legacy = new DatabaseSync(join(store.dir, 'memory.db'))
    legacy.exec('CREATE TABLE mem_meta (memoryId TEXT PRIMARY KEY, sessionId TEXT, category TEXT, createdAt INTEGER)')
    legacy.exec("CREATE VIRTUAL TABLE mem_idx USING fts5(content, sessionId UNINDEXED, memoryId UNINDEXED, category UNINDEXED, createdAt UNINDEXED, tokenize='trigram')")
    legacy.exec("INSERT INTO mem_idx (content, sessionId, memoryId, category, createdAt) VALUES ('alpha beta gamma', 's1', 'm1', 'general', 1)")
    legacy.close()

    const index = await openSearchIndex({ memoryDir: store.dir })
    assert(index !== null)
    try {
      const rebuilt = await index.rebuild()
      assertEqual(rebuilt.inserted, 1, 'the rebuild refilled the recreated table')
      assertEqual(index.search('x.js', { limit: 5 }).map((row) => row.memoryId), ['m1'])
    } finally {
      index.close()
    }
  } finally {
    await store.dispose()
  }
})

test('files are searchable, and short queries still fall back to LIKE', async () => {
  const store = await tempStore()
  try {
    const index = await openSearchIndex({ memoryDir: store.dir })
    assert(index !== null)
    try {
      index.upsert({
        sessionId: 's1',
        memoryId: 'm1',
        category: 'bugfix',
        content: '修好了注入重复的问题',
        createdAt: 1,
        files: [{ path: 'index.js', action: 'modified' }, { path: 'search-index.js', action: 'read' }],
      })
      assertEqual(index.search('index.js', { limit: 5 }).map((row) => row.memoryId), ['m1'])
      assertEqual(index.search('注入', { limit: 5 }).map((row) => row.memoryId), ['m1'], '2-char CJK goes through LIKE')
      assertEqual(index.search('不存在的词', { limit: 5 }).length, 0)
      index.remove({ memoryId: 'm1' })
      assertEqual(index.search('index.js', { limit: 5 }).length, 0)
    } finally {
      index.close()
    }
  } finally {
    await store.dispose()
  }
})
