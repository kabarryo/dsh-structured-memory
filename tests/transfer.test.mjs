import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  test, assert, assertEqual, tempStore, memoryTools, fakeAgent,
  bridgeRoutes, callRoute, readStoreFile,
} from './lib/harness.mjs'
import { buildExportBundle, parseExportBundle } from '../index.js'

const TRANSFER = '/api/dsh-structured-memory-transfer'

async function seedStore() {
  const store = await tempStore()
  const tools = await memoryTools(store.config)
  await tools.save_memory.execute({
    content: 'alpha conclusion about index.js',
    trigger: 'user-request',
    keyPoint: 'alpha',
    category: 'bugfix',
    files: [{ path: 'index.js', action: 'modified' }],
  }, { agent: fakeAgent('s-alpha') })
  await tools.save_memory.execute({
    content: 'beta conclusion about docs',
    trigger: 'user-request',
    keyPoint: 'beta',
    category: 'decision',
  }, { agent: fakeAgent('s-beta') })
  const routes = await bridgeRoutes(store.config)
  return { store, tools, routes }
}

const exportBundle = async (routes, options = {}) => callRoute(routes.get(TRANSFER), {
  method: 'POST',
  url: `${TRANSFER}?export=1`,
  body: options,
})

const importBundle = async (routes, file, options = {}) => callRoute(routes.get(TRANSFER), {
  method: 'POST',
  url: `${TRANSFER}?import=${encodeURIComponent(file)}`,
  body: { confirm: true, ...options },
})

/** Move an exported bundle into another store's transfer directory. */
async function shareBundle(fromDir, toDir, file) {
  await mkdir(join(toDir, 'transfer'), { recursive: true })
  await copyFile(join(fromDir, 'transfer', file), join(toDir, 'transfer', file))
}

test('export writes a checksummed bundle into the transfer directory', async () => {
  const { store, routes } = await seedStore()
  try {
    const result = await exportBundle(routes)
    assertEqual(result.json.ok, true)
    assertEqual(result.json.inTransfer, true, 'default destination is the transfer dir')
    assertEqual(result.json.counts.sessions, 2)
    assertEqual(result.json.counts.memories, 2)

    const text = await readFile(join(store.dir, 'transfer', result.json.file), 'utf8')
    const parsed = parseExportBundle(text)
    assertEqual(parsed.ok, true)
    assertEqual(parsed.bundle.checksum, result.json.checksum)
    assertEqual(parsed.bundle.sessions.length, 2)
  } finally {
    await store.dispose()
  }
})

test('a tampered bundle is refused at preview time (checksum covers the payload)', async () => {
  const { store, routes } = await seedStore()
  try {
    const exported = await exportBundle(routes)
    const path = join(store.dir, 'transfer', exported.json.file)
    const bundle = JSON.parse(await readFile(path, 'utf8'))
    bundle.sessions[0].memories[0].content = 'tampered content'
    await writeFile(path, JSON.stringify(bundle))

    const preview = await callRoute(routes.get(TRANSFER), {
      method: 'GET',
      url: `${TRANSFER}?preview=${encodeURIComponent(exported.json.file)}`,
    })
    assertEqual(preview.json.ok, false)
    assertEqual(preview.json.code, 'checksum-mismatch')
  } finally {
    await store.dispose()
  }
})

test('import requires explicit confirmation', async () => {
  const { store, routes } = await seedStore()
  try {
    const exported = await exportBundle(routes)
    const refused = await callRoute(routes.get(TRANSFER), {
      method: 'POST',
      url: `${TRANSFER}?import=${encodeURIComponent(exported.json.file)}`,
      body: {},
    })
    assertEqual(refused.json.ok, false)
    assertEqual(refused.json.code, 'confirm-required')
  } finally {
    await store.dispose()
  }
})

test('importing into an empty store recreates both sessions', async () => {
  const source = await seedStore()
  const target = await tempStore()
  try {
    const exported = await exportBundle(source.routes)
    await shareBundle(source.store.dir, target.dir, exported.json.file)
    const routes = await bridgeRoutes(target.config)

    const result = await importBundle(routes, exported.json.file)
    assertEqual(result.json.ok, true)
    assertEqual(result.json.report.created.length, 2)
    assertEqual(result.json.report.merged.length, 0)

    const tools = await memoryTools(target.config)
    const recalled = await tools.recall_memory.execute({ query: 'alpha conclusion' }, { agent: fakeAgent('probe') })
    assertEqual(recalled.sessions.map((row) => row.sessionId), ['s-alpha'])
    const doc = await readStoreFile(target.dir, 'sessions/s-alpha.json')
    assertEqual(doc.memories[0].files, [{ path: 'index.js', action: 'modified' }], 'file coordinates survive the bundle')
  } finally {
    await source.store.dispose()
    await target.dispose()
  }
})

test('onExisting=skip leaves the target session untouched', async () => {
  const source = await seedStore()
  const target = await seedStore()
  try {
    const exported = await exportBundle(source.routes)
    await shareBundle(source.store.dir, target.store.dir, exported.json.file)
    const before = await readStoreFile(target.store.dir, 'sessions/s-alpha.json')
    const routes = await bridgeRoutes(target.store.config)

    const result = await importBundle(routes, exported.json.file, { onExisting: 'skip' })
    assertEqual(result.json.ok, true)
    assertEqual(result.json.report.skipped.length, 2)
    const after = await readStoreFile(target.store.dir, 'sessions/s-alpha.json')
    assertEqual(after.memories[0].content, before.memories[0].content)
  } finally {
    await source.store.dispose()
    await target.store.dispose()
  }
})

test('onExisting=replace overwrites the session content', async () => {
  const source = await seedStore()
  const target = await seedStore()
  try {
    const exported = await exportBundle(source.routes)
    await shareBundle(source.store.dir, target.store.dir, exported.json.file)
    const routes = await bridgeRoutes(target.store.config)
    const result = await importBundle(routes, exported.json.file, { onExisting: 'replace' })
    assertEqual(result.json.ok, true)
    assertEqual(result.json.report.replaced.length, 2)
    const doc = await readStoreFile(target.store.dir, 'sessions/s-alpha.json')
    assertEqual(doc.memories.length, 1, 'replace installs the bundle shape, still one memory')
  } finally {
    await source.store.dispose()
    await target.store.dispose()
  }
})

test('remapSessions creates new ids and records the origin lineage', async () => {
  const source = await seedStore()
  const target = await seedStore()
  try {
    const exported = await exportBundle(source.routes)
    await shareBundle(source.store.dir, target.store.dir, exported.json.file)
    const routes = await bridgeRoutes(target.store.config)
    const result = await importBundle(routes, exported.json.file, { remapSessions: true })
    assertEqual(result.json.ok, true)
    assertEqual(result.json.report.remapped.length, 2)
    const remapped = result.json.report.remapped[0]
    assert(remapped.to.startsWith('session-imported-'), remapped.to)
    const doc = await readStoreFile(target.store.dir, `sessions/${remapped.to}.json`)
    assertEqual(doc.origin.originSessionId, remapped.from)
    assert(await readStoreFile(target.store.dir, `sessions/${remapped.from}.json`), 'the original session still exists')
  } finally {
    await source.store.dispose()
    await target.store.dispose()
  }
})

test('rollback restores the pre-import state', async () => {
  const source = await seedStore()
  const target = await tempStore()
  try {
    const exported = await exportBundle(source.routes)
    await shareBundle(source.store.dir, target.dir, exported.json.file)
    const routes = await bridgeRoutes(target.config)
    const imported = await importBundle(routes, exported.json.file)
    assertEqual(imported.json.ok, true)
    assert(await readStoreFile(target.dir, 'sessions/s-alpha.json'), 'session appeared')

    const snapshots = await callRoute(routes.get(TRANSFER), { method: 'GET', url: `${TRANSFER}?snapshots=1` })
    assertEqual(snapshots.json.ok, true)
    const snapshot = snapshots.json.snapshots.find((row) => row.rollbackable === true && row.kind === 'dsh-structured-memory-import-snapshot')
    assert(snapshot !== undefined, JSON.stringify(snapshots.json.snapshots))

    const rolled = await callRoute(routes.get(TRANSFER), {
      method: 'POST',
      url: `${TRANSFER}?rollback=${encodeURIComponent(snapshot.snapshot)}`,
      body: {},
    })
    assertEqual(rolled.json.ok, true)
    assertEqual(await readStoreFile(target.dir, 'sessions/s-alpha.json'), null, 'the created session is removed again')
  } finally {
    await source.store.dispose()
    await target.dispose()
  }
})

test('export destinations are confined to the allowed roots and must be .json', async () => {
  const { store, routes } = await seedStore()
  try {
    const outside = await exportBundle(routes, { dest: '/etc/evil.json' })
    assertEqual(outside.json.ok, false)
    assert(/路径必须位于/.test(outside.json.message), outside.json.message)

    const wrongExt = await exportBundle(routes, { dest: '/tmp/not-a-bundle.txt' })
    assertEqual(wrongExt.json.ok, false)
    assert(/\.json/.test(wrongExt.json.message), wrongExt.json.message)
  } finally {
    await store.dispose()
  }
})

test('an existing export file is not overwritten unless asked', async () => {
  const { store, routes } = await seedStore()
  try {
    // `/tmp` is an allowed export root; the store's own tmpdir (under
    // /var/folders) is deliberately NOT, which the confinement test covers.
    const dest = `/tmp/dsm-named-export-${process.pid}.json`
    await rm(dest, { force: true })
    const first = await exportBundle(routes, { dest })
    assertEqual(first.json.ok, true)

    const second = await exportBundle(routes, { dest })
    assertEqual(second.json.ok, false)
    assertEqual(second.json.code, 'dest-exists')

    const forced = await exportBundle(routes, { dest, overwrite: true })
    assertEqual(forced.json.ok, true)
    await rm(dest, { force: true })
  } finally {
    await store.dispose()
  }
})

test('export scope can be narrowed to one session', async () => {
  const { store, routes } = await seedStore()
  try {
    const result = await exportBundle(routes, { sessionIds: ['s-alpha'] })
    assertEqual(result.json.ok, true)
    assertEqual(result.json.counts.sessions, 1)
    assertEqual(result.json.counts.memories, 1)
    assert(/-sessions-1\.json$/.test(result.json.file), result.json.file)
  } finally {
    await store.dispose()
  }
})

test('import scrubs <private> content from a bundle it did not create', async () => {
  const target = await tempStore()
  try {
    const bundle = buildExportBundle({
      version: 'test',
      profile: null,
      entries: [],
      at: 1,
      options: {},
      sessions: [{
        sessionId: 's-leaky',
        title: 'Leaky',
        origin: null,
        memories: [{ id: 'm1', content: 'visible <private>sk-should-not-land</private> tail', category: 'general', createdAt: 1 }],
      }],
    })
    await mkdir(join(target.dir, 'transfer'), { recursive: true })
    await writeFile(join(target.dir, 'transfer', 'leaky.json'), JSON.stringify(bundle))

    const routes = await bridgeRoutes(target.config)
    const result = await importBundle(routes, 'leaky.json')
    assertEqual(result.json.ok, true)
    const doc = await readStoreFile(target.dir, 'sessions/s-leaky.json')
    assertEqual(doc.memories[0].content.includes('sk-should-not-land'), false)
    assert(doc.memories[0].content.includes('visible'), doc.memories[0].content)
  } finally {
    await target.dispose()
  }
})
