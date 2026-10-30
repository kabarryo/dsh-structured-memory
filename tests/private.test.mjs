import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, assert, assertEqual } from './lib/harness.mjs'
import { tempStore, memoryTools, fakeAgent } from './lib/harness.mjs'
import { stripPrivateSpans, buildToolDescriptions } from '../index.js'

/** Every byte the plugin persisted for this store, concatenated (binary-safe lossy). */
async function storeBytes(dir) {
  const parts = []
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else parts.push(await readFile(full, 'utf8'))
    }
  }
  await walk(dir)
  return parts.join('\n')
}

test('complete private spans are excised, several per text', () => {
  const one = stripPrivateSpans('保留 A <private>秘密</private> 保留 B')
  assert(!one.text.includes('秘密'), 'secret is gone')
  assert(one.text.includes('保留 A') && one.text.includes('保留 B'), 'neighbours survive')
  assertEqual(one.removed, 1)

  const many = stripPrivateSpans('<private>a</private>x<private>b</private>')
  assertEqual(many.text, 'x')
  assertEqual(many.removed, 2)
})

test('an unterminated opener drops the rest of the text', () => {
  const dangling = stripPrivateSpans('可见 <private>之后全部丢弃')
  assertEqual(dangling.text, '可见')
  assertEqual(dangling.removed, 1)
})

test('text without the marker is returned unchanged', () => {
  assertEqual(stripPrivateSpans('普通内容\n第二行'), { text: '普通内容\n第二行', removed: 0 })
  assertEqual(stripPrivateSpans(''), { text: '', removed: 0 })
  assertEqual(stripPrivateSpans(undefined), { text: '', removed: 0 })
})

test('a saved memory never reaches disk with its <private> span', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    const result = await tools.save_memory.execute({
      content: '结论 A <private>sk-secret-123</private> 结论 B',
      trigger: 'user-request',
      keyPoint: '结论 A <private>另一个秘密</private>',
    }, { agent: fakeAgent('sess-private') })

    assertEqual(result.stored, true)
    assertEqual(result.redacted, 2, 'both spans counted')
    const bytes = await storeBytes(store.dir)
    assert(!bytes.includes('sk-secret-123'), 'content secret is not on disk')
    assert(!bytes.includes('另一个秘密'), 'keyPoint secret is not on disk')
    assert(bytes.includes('结论 A') && bytes.includes('结论 B'), 'the rest survived')
  } finally {
    await store.dispose()
  }
})

test('a save that is entirely private is refused, not stored empty', async () => {
  const store = await tempStore()
  try {
    const tools = await memoryTools(store.config)
    let error = null
    try {
      await tools.save_memory.execute({ content: '<private>只有秘密</private>', trigger: 'user-request' }, { agent: fakeAgent('sess-empty') })
    } catch (caught) {
      error = caught
    }
    assert(error !== null, 'the save throws instead of writing an empty memory')
    assert(/empty after removing <private>/.test(String(error.message)), error.message)
  } finally {
    await store.dispose()
  }
})

test('a synthesis draft cannot reintroduce a private span', async () => {
  const { evaluateSessionConsolidation } = await import('../index.js')
  const doc = { sessionId: 's', memories: [{ id: 'm1', content: '结论', category: 'general', createdAt: 1 }] }
  const evaluation = evaluateSessionConsolidation(doc, { content: '结论 <private>sk-999</private> 尾巴', category: 'general' })
  assert(!evaluation.next[0].content.includes('sk-999'))
})

test('the compact save description documents the private convention', () => {
  assert(buildToolDescriptions({ skillGuide: true }).save.includes('<private>'))
})
