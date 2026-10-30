# dsh-structured-memory P1/P2 实施计划

> **给执行者的前置要求：** 逐任务执行，每个任务都是「写失败测试 → 跑测试确认失败 → 最小实现 → 跑测试确认通过 → 快照/版本号」的闭环。不要一次改多个任务。
>
> **依据：** `docs/claude-mem-comparison.md` 第四节「claude-mem 值得借鉴的（按性价比）」的 P1 两项与 P2 三项。

**Goal:** 补齐对比文档点名的 P1/P2 五项能力——写入时采集文件字段、检索用法移进 skill、timeline 视图、类型化记忆、`<private>` 排除标记——并让每一项都有可重复执行的回归测试兜底（当前仓库 0 个测试）。

**Architecture:** 不引入新存储、不引入新进程、不引入新依赖。`sessions/*.json` 仍是唯一事实源；`memory.db` 仍是可丢弃重建的派生索引（本次新增 `files` 列，靠「检测列缺失 → DROP → 重建」自愈，不做原地迁移）。文件字段与类型都落在既有 JSON 结构里，检索与时间轴都是从既有数据**派生**的读路径。工具描述瘦身通过新增一个 runtime skill 承载长文档，宿主没有 skills 服务时自动回退到长描述。

**Tech Stack:** 纯 ESM JavaScript（Node ≥ 20，本机 26.3.1）、`node:sqlite` FTS5（trigram）、`@deepseek-ai/dsh-tools` 的 `defineTool`、`ctx.skills.register`（可选服务）、零测试框架依赖（Node 内置 `node:test` 不用，改用本计划的 60 行 runner）。

---

## 目录

- [执行约定](#执行约定)
- [实测基线](#实测基线)
- [设计决策](#设计决策)
- [任务依赖与顺序](#任务依赖与顺序)
- [Phase 0：最小测试脚手架](#phase-0最小测试脚手架)
- [Phase 1（P1）：写入时采集文件字段](#phase-1p1写入时采集文件字段)
- [Phase 2（P1）：检索用法移进 skill](#phase-2p1检索用法移进-skill)
- [Phase 3（P2）：类型化记忆](#phase-3p2类型化记忆)
- [Phase 4（P2）：`<private>` 排除标记](#phase-4p2private-排除标记)
- [Phase 5（P2）：timeline 视图](#phase-5p2timeline-视图)
- [Phase 6：文档、版本号与验收](#phase-6文档版本号与验收)
- [风险与回滚](#风险与回滚)
- [明确不在本计划内](#明确不在本计划内)

---

## 执行约定

**本目录不是 git 仓库**（`git status` → `fatal: not a git repository`）。README「备份」一节的既有惯例是 `.bak-v<version>` 快照 + npm 版本号，本计划沿用，**不要** `git init`。

每个 Phase 开始前跑一次快照（Phase 1 前是 `v2.19.6`，Phase 3 起是 `v2.20.0`，Phase 5 起是 `v2.21.0`）：

```sh
cd /Users/ryo/vibing/dsh_plugin_dev/dsh-structured-memory
cp index.js index.js.bak-v2.19.6     # Phase 1、2 之前
cp index.js index.js.bak-v2.20.0     # Phase 3、4 之前
cp index.js index.js.bak-v2.21.0     # Phase 5、6 之前
```

`client.js` 本次不动，不必快照。

版本号有两处必须同步：`index.js:97` 的 `PLUGIN_VERSION` 与 `package.json` 的 `version`（当前均为 `2.19.6`）。Phase 1+2 合并发布为 **2.20.0**，Phase 3+4+5 合并发布为 **2.21.0**。

测试命令（Phase 0 建立后全局可用）：

```sh
npm test
# 等价于：node --import ./tests/lib/register.mjs ./tests/run.mjs
```

**验收口径**：每项能力都必须有一条「坏实现会失败」的断言，而不是「能跑通」的断言。例如文件字段的验收不是「save 不报错」，而是「按文件路径能召回该记忆」；`<private>` 的验收不是「函数存在」，而是「`秘密` 不出现在 session JSON、FTS 行、导出 bundle 里」。

---

## 实测基线

以下数字都是本次读取源码/实测得到，不是文档转述：

| 项 | 实测 | 出处 |
|---|---|---|
| `save_memory` 描述（模型实际看到的长度） | **2,009 字符，末尾是未展开的 `${SAVE_MEMORY_CONTENT_RULE}`** | 双引号字面量，不做插值（执行时用 `setupTools` 实测确认） |
| `recall_memory` 描述 | 555 字符 | `index.js:1210` |
| `load_session_memory` 描述 | 228 字符 | `index.js:1421` |
| `forget_memory` 描述 | 262 字符 | `index.js:1466` |
| 三个检索/写入工具的常驻描述合计 | **2,792 字符**（现状，含死占位符） | 上三行之和（不含 forget） |
| 修好插值后的回退长文 | **2,813 字符** | 1,982 + `SAVE_MEMORY_CONTENT_RULE`（831） |
| FTS 表结构 | `mem_idx(content, sessionId, memoryId, category, createdAt)`，trigram | `search-index.js:44` |
| 单条记忆字段 | `id, content, category, createdAt, updatedAt, mergedCount, mergedFrom?` | `index.js:1827` |
| 会话条数 / 记忆条数 | 18 / 18（每会话 1 条） | 对比文档第五节 |
| `node:sqlite` | 可用（Node 26.3.1） | 实测 `import('node:sqlite')` |
| 插件目录测试数 | 0（`tests/test-*.mjs` 是 0 字节误建文件） | 实测 |
| 本会话是否挂载了本插件 | **否**（`listTools` 无 `save_memory`）；端到端验收需在挂载了插件的会话或重启后做 | `cordis_inspect_query(host, Tool)` |
| 本机真库的 FTS 列 | `content, sessionId, memoryId, category, createdAt`（**无 `files`**）→ 2.20.0 上线后必走一次自愈迁移 | `PRAGMA table_info(mem_idx)` on `~/.dsh/memory/memory.db` |

**本计划代码的验证状态**（写计划时已在 `/tmp` 副本上跑过，不是纸面推演）：

| Phase | 验证方式 | 结果 |
|---|---|---|
| 0 | 用计划里的 harness + `registerHooks` stub 真实跑起来 | ✅ 可 import `index.js` |
| 1 | 在副本上按计划逐条改 `index.js`/`search-index.js`，跑计划里的 9 条用例 | ✅ 9/9（含旧库自愈迁移、按路径召回） |
| 2 | 用计划里的紧凑文案实测字符数（执行阶段定稿） | ✅ 1237 / 306 / 172 = 1,715（长文 2,813 / 555 / 228 = 3,596） |
| 3 | 纯逻辑跑 `normalizeCategory` / 类型优先级 / `ANCHOR_PATTERN` | ✅ 别名、优先级、安全锚点均符合断言 |
| 4 | 在副本上接进真实 `save_memory.execute`，扫全目录 | ✅ 3/3（秘密不落盘、全私密拒存） |
| 5 | 窗口取整与锚点定位算法单独跑过 | ✅ 窗口正确；`recall` 路由（4 行）未执行，靠用例兜底 |

**已验证的技术前提**（本次 spike，不需要重复验证）：

1. `index.js` 在 DSH 外**无法** `import`：`Cannot find package '@deepseek-ai/schemastery'`。用 `module.registerHooks`（Node ≥ 22.15）把三个 `@deepseek-ai/*` 裸导入映射到本地 stub 后，`import('./index.js')` 成功并暴露 19 个导出。
2. FTS5 **不支持** `ALTER TABLE ADD COLUMN`，但对派生表执行 `DROP TABLE` + `CREATE` + `rebuild()` 可行；`PRAGMA table_info(mem_idx)` 能读到虚拟表列名（`content, sessionId`）。
3. 新增 `files` 列后，`mem_idx MATCH '"search-index.js"'` 能命中（trigram 覆盖文件路径）。
4. `@deepseek-ai/dsh-tools` 的参数 DSL 支持 `type:'array'` + `items`、嵌套 `type:'object'` + `additionalProperties:false` + `required:true`、以及字符串 `enum`（`lib/types/schema.d.ts`）。
5. `ctx.skills` 是**可选**服务：`ctx.get('skills')` 返回 `undefined` 是合法状态；`register(skill)` 的返回是 disposer；`SkillRegistration` 需要 `source` 字段。

---

## 设计决策

下面每条都是「有取舍」的决定，执行时不要改回另一种写法；要改先在 PR/提交说明里说明理由。

| 决策 | 选择 | 被否决的选项与原因 |
|---|---|---|
| 文件字段的形状 | `files: [{path, action:'read'\|'modified'}]`，与 `content` 同存于单条记忆并在多次保存间**并集累积** | 单独建 `files.json` 事件表：与「每会话一条记忆」冲突，且要新增一致性问题。只做 `files: string[]`：回答不了「这个文件以前被改过还是只读过」 |
| 文件字段是否进注入 | **否**。只进 FTS 与召回结果 | 进 `global.json` 注入层：每条多 10–40 token，18 条会话即 -5%~-15% 预算，而「按文件查」是低频需求，按需检索即可 |
| FTS schema 迁移 | 列缺失 → `DROP TABLE mem_idx` → 重建，启动后自动 `rebuild()` | 加 `user_version` + 手写迁移：派生库本来就可丢，多写迁移代码是纯负债 |
| 长文档的载体 | 新增 `skill.js`（runtime skill），`ctx.get('skills')` 存在时注册 | 塞进 `client.js` 页面：模型看不到，省不了 token |
| 没有 skills 服务时 | 回退到**完整长描述**（2,813；顺手修掉从未展开的 `${SAVE_MEMORY_CONTENT_RULE}`），测试钉住 `>= 2700` 且「不得含 `${`」 | 直接删长描述：在 headless/旧宿主上会丢失「何时该存」与内容规则 |
| 类型化记忆的数据模型 | 沿用一个 `category`，**模型写入路径**归一化为 5 值枚举；读取/导出/编辑器写入**不重写** | 新增 `type` 字段：模型每次要判断两个字段，参数面与注入文案都变大；强制改存量数据：属于破坏性迁移 |
| 编辑器的 category 是否归一化 | **不**。页面是 `category` 的逃生口，README 写明 | 一并归一化：会把操作者手填的 `教务/公文` 类标签静默改成 `general` |
| `/dream` 的类型差异 | `security` 类型加**硬闸**（丢锚点即拒绝应用）+ 合成后类型优先级 `security > decision > bugfix > preference > general` | 只写进提示词：与「三条硬闸只靠 README 承诺」同一个病，测试无法断言 |
| `<private>` 的处理位置 | 写入端一次性切除（save / 桥接 / dream 草稿 / 导入），四处共用 `stripPrivateSpans` | 读取端过滤：claude-mem 的 `dedupe.ts` 已经证明「读端补救」是下策，隐私场景更是不能先落盘再过滤 |
| timeline 的锚点 | `recall_memory({scope:'timeline', sessionId})`，`limit` 是**窗口行数**（不是每侧行数） | 新增第 5 个工具：工具面每加一个就多一份常驻 schema，检索类已有 `recall_memory` 可扩 |
| timeline 是否做 UI | 只做工具层（本次确认） | 改 89 KB 的 `client.js` 加时间轴页签：工作量大且需要构建/刷新验证，收益低 |

---

## 任务依赖与顺序

```
Phase 0 (测试脚手架)
   └─> Phase 1 (files: 结构 → 写入 → FTS → 导出/桥接/dream)
          └─> Phase 2 (skill + 描述瘦身)         ← 依赖 index.js 已有 buildToolDescriptions 出口
   └─> Phase 3 (category 枚举 + dream 硬闸)
          └─> Phase 4 (<private>，复用 save/dream/import 的写入点)
          └─> Phase 5 (timeline，只读路径，可与 3/4 并行)
```

- **Phase 1 必须在 Phase 2 之前**：描述瘦身要顺带把 `files`、`category` 写进新描述，先落地结构才能写准文案。
- **Phase 3 在 Phase 4 之前**：两者都改 `mergeIntoSessionMemory` 的调用点与 dream 草稿处理，先做分类再做脱敏，避免同一次 diff 混两类语义。
- **Phase 5 与 3/4 无耦合**，可以并行；但 timeline 的 skill 文档要等 Phase 2 的 skill 已存在。

---

## Phase 0：最小测试脚手架

> 这**不是**对比文档的 P0（重建 5 套 / 289 断言）。这里只造一个能让后续每个任务做真 TDD 的最小机关：stub 加载器 + 60 行 runner。P0 的整套重建仍是独立事项。

### Task 0.1：让 `index.js` 能在 DSH 之外被 import

**Files:**
- Create: `tests/lib/stubs/schemastery.mjs`
- Create: `tests/lib/stubs/dsh-tools.mjs`
- Create: `tests/lib/stubs/dsh-llm.mjs`
- Create: `tests/lib/register.mjs`

**Step 1: 写 stub**

`tests/lib/stubs/schemastery.mjs`：

```js
/**
 * Test stub for @deepseek-ai/schemastery.
 *
 * The plugin only needs `z` to BUILD its Config schema at import time; nothing
 * validates against it outside DSH. Every call therefore returns a chainable
 * stand-in, so both `z.object({...})` and `.number().step(1).min(1).volatile()`
 * work without pulling the real package into the test process.
 */
const chain = (base) => new Proxy(base, {
  get: (target, key) => {
    if (key === 'then') return undefined // never look thenable to the loader
    if (key in target) return target[key]
    return (...args) => chain({ ...target, [key]: args })
  },
})

export const z = {
  object: (shape) => chain({ type: 'object', shape }),
  string: () => chain({ type: 'string' }),
  number: () => chain({ type: 'number' }),
  boolean: () => chain({ type: 'boolean' }),
}

export default z
```

`tests/lib/stubs/dsh-tools.mjs`：

```js
/** Test stub for @deepseek-ai/dsh-tools: registration is a no-op outside DSH. */
export const defineTool = (definition) => definition
```

`tests/lib/stubs/dsh-llm.mjs`：

```js
/** Test stubs for the two @deepseek-ai/dsh-llm exports the plugin imports. */
export const createUserMessage = (value) => value

export class BlockAssembler {
  constructor() {
    this.usage = null
    this.finish = null
  }

  blocks() {
    return []
  }
}
```

`tests/lib/register.mjs`：

```js
/**
 * Map the three DSH packages the plugin imports onto local stubs so plain
 * `node` can import index.js. Uses `registerHooks` (Node >= 22.15) instead of the
 * deprecated async `module.register()` loader.
 */
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

const stub = (file) => pathToFileURL(new URL(file, import.meta.url).pathname).href
const targets = new Map([
  ['@deepseek-ai/schemastery', stub('./stubs/schemastery.mjs')],
  ['@deepseek-ai/dsh-tools', stub('./stubs/dsh-tools.mjs')],
  ['@deepseek-ai/dsh-llm', stub('./stubs/dsh-llm.mjs')],
])

registerHooks({
  resolve(specifier, context, next) {
    const url = targets.get(specifier)
    if (url !== undefined) return { url, shortCircuit: true }
    return next(specifier, context)
  },
})
```

**Step 2: 验证 import 可用**

```sh
node --import ./tests/lib/register.mjs \
  -e "import('./index.js').then(m => console.log('exports:', Object.keys(m).length)).catch(e => { console.error(e.message); process.exit(1) })"
```

Expected: `exports: 19`（不出现 `DEP0205` 弃用告警）。

**Step 3: 删除误建的空占位文件**

```sh
rm "tests/test-*.mjs"
```

（这是 2026-10-21 目录迁移时误建的字面文件名 `test-*.mjs`，0 字节，不是 glob。）

---

### Task 0.2：runner 与断言工具

**Files:**
- Create: `tests/lib/harness.mjs`
- Create: `tests/run.mjs`
- Modify: `package.json`（`scripts.test`）

**Step 1: 写测试工具**

`tests/lib/harness.mjs`：

```js
/** A ~60-line test registry: zero dependencies, so the suite runs on plain node. */
const registry = []

export function test(name, fn) {
  registry.push({ name, fn })
}

export function registered() {
  return registry
}

export function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}

export function assertEqual(actual, expected, message = '') {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${message}${message ? ': ' : ''}expected ${e}, got ${a}`)
}

/** Temp memory root plus a config object shaped like the plugin's. */
export async function tempStore() {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dsm-test-'))
  return {
    dir,
    config: { memoryDir: dir },
    dispose: () => rm(dir, { recursive: true, force: true }),
  }
}

/**
 * Instantiate the plugin's real tools against a temp store: `setupTools` only
 * needs `ctx.tools.register`, so the tests can drive `execute()` exactly like
 * the model does — no DSH runtime, no agent loop.
 */
export async function memoryTools(config) {
  const { setupTools } = await import('../../index.js')
  const tools = {}
  const ctx = { tools: { register: (definition) => { tools[definition.name] = definition; return () => {} } } }
  setupTools(ctx, config)
  return tools
}

/** The minimum shape the write guards read from an Agent. */
export function fakeAgent(id = 'test-session') {
  return { id, session: { header: {} } }
}
```

> 这条 helper 依赖 `setupTools` 被导出（Task 1.2 Step 3）。已验证可行：fake ctx 下 `save_memory.execute()` 能真实写出 `sessions/<id>.json`、`global.json` 与基础 `memory.db`。

`tests/run.mjs`：

```js
/**
 * Test runner: imports every tests/*.test.mjs (which register cases through
 * harness.test), then runs them with a 10s timeout. Exits non-zero on failure so
 * `npm test` is usable in a pre-commit/subagent loop.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registered } from './lib/harness.mjs'

const here = fileURLToPath(new URL('./', import.meta.url))
const files = (await readdir(here)).filter((name) => name.endsWith('.test.mjs')).sort()
for (const file of files) await import(pathToFileURL(join(here, file)).href)

const cases = registered()
let passed = 0
const failures = []

for (const { name, fn } of cases) {
  const started = Date.now()
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout after 10s')), 10_000)),
    ])
    passed += 1
    console.log(`ok   ${name} (${Date.now() - started}ms)`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL ${name}`)
    const lines = String(error?.stack ?? error).split('\n').slice(0, 6)
    for (const line of lines) console.log(`     ${line}`)
  }
}

console.log(`\n${passed}/${cases.length} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
```

**Step 2: 接上 npm script**

`package.json` 的 `"type": "module"` 之后、`"main"` 之前插入：

```json
  "scripts": {
    "test": "node --import ./tests/lib/register.mjs ./tests/run.mjs"
  },
```

**Step 3: 跑一次空套件**

```sh
npm test
```

Expected: `0/0 passed, 0 failed`（还没有 `.test.mjs`；退出码 0）。

---

### Task 0.3：第一个契约测试（证明 import 与纯函数可用）

**Files:**
- Create: `tests/contracts.test.mjs`

**Step 1: 写失败测试**

```js
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
```

**Step 2: 运行**

```sh
npm test
```

Expected: `2/2 passed, 0 failed`。如果 import 报 `ERR_MODULE_NOT_FOUND`，说明 `tests/lib/register.mjs` 没被 `--import` 到，回到 Task 0.1 Step 2 排查。

**Step 3: 快照**

```sh
cp index.js index.js.bak-v2.19.6
```

---

## Phase 1（P1）：写入时采集文件字段

**目标（可验收）**：一次 `save_memory({files:[{path:'index.js',action:'modified'}]})` 之后，`recall_memory({query:'index.js'})` 能召回该记忆；`memory.db` 的 `mem_meta.files` 有结构化 JSON；导出/导入 bundle 往返不丢 `files`；`/dream` 压缩后 `files` 仍在。

### Task 1.1：`normalizeFiles` 与去重合并

**Files:**
- Modify: `index.js`（在 `mergeIntoSessionMemory` 之前，即 `index.js:1816` 附近）
- Test: `tests/files.test.mjs`

**Step 1: 写失败测试**

`tests/files.test.mjs`：

```js
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
```

**Step 2: 运行确认失败**

```sh
npm test
```

Expected: FAIL，`normalizeFiles is not a function` / `ReferenceError`。

**Step 3: 实现**

在 `/** ... Fold a session's memories into exactly one entry ... */` 之前插入：

```js
/** Cap on the file paths one session memory carries, so the stored shape stays bounded. */
export const MAX_MEMORY_FILES = 50

/**
 * Normalize a `files` argument into `[{ path, action }]` (v2.20).
 *
 * Accepts objects (`{path, action}`) and bare strings (treated as a read), drops
 * empty paths, de-duplicates by path, and lets `modified` win over `read` — a
 * file that was edited was also read. First-seen order, so a stable input yields
 * a stable stored list (and a stable export checksum).
 */
export function normalizeFiles(raw) {
  const out = []
  const byPath = new Map()
  for (const item of Array.isArray(raw) ? raw : []) {
    const rawPath = typeof item === 'string'
      ? item
      : (isRecord(item) && typeof item.path === 'string' ? item.path : '')
    const path = rawPath.trim().replace(/\\/g, '/').slice(0, 200)
    if (path.length === 0) continue
    const action = isRecord(item) && item.action === 'modified' ? 'modified' : 'read'
    const known = byPath.get(path)
    if (known !== undefined) {
      if (action === 'modified') known.action = 'modified'
      continue
    }
    if (out.length >= MAX_MEMORY_FILES) continue
    const entry = { path, action }
    byPath.set(path, entry)
    out.push(entry)
  }
  return out
}

/** Union two file lists (existing first, incoming second: a later edit wins). */
function mergeSessionFiles(existing, incoming) {
  return normalizeFiles([
    ...(Array.isArray(existing) ? existing : []),
    ...normalizeFiles(incoming),
  ])
}
```

替换 `mergeIntoSessionMemory` 整个函数体：

```js
export function mergeIntoSessionMemory(doc, content, category, files = []) {
  if (doc.memories.length > 1) collapseSessionMemories(doc)
  const incoming = normalizeFiles(files)
  const fingerprint = normalizeMemoryText(content)
  const single = doc.memories[0]
  if (single === undefined) {
    const record = {
      id: randomUUID(),
      content,
      category,
      createdAt: Date.now(),
      mergedCount: 1,
      ...(incoming.length > 0 ? { files: incoming } : {}),
    }
    doc.memories.push(record)
    doc.updatedAt = record.createdAt
    return { doc, id: record.id, merged: false, created: true, filesChanged: incoming.length > 0 }
  }
  const knownFiles = normalizeFiles(single.files)
  const nextFiles = mergeSessionFiles(knownFiles, incoming)
  const filesChanged = nextFiles.length !== knownFiles.length
    || nextFiles.some((file, index) => file.action !== knownFiles[index].action)
  if (normalizeMemoryText(single.content).includes(fingerprint)) {
    // A repeated fact still carries coordinates: record the files it touched.
    if (filesChanged) single.files = nextFiles
    return {
      doc,
      id: single.id,
      merged: false,
      created: false,
      filesChanged,
      reason: `already contained in this session's single memory ${single.id} — ${filesChanged ? 'only the file list was updated' : 'nothing written'}`,
    }
  }
  const merged = `${single.content}\n${content}`.trim()
  if (Array.from(merged).length > SESSION_MEMORY_MAX_CHARS) {
    return {
      doc,
      id: single.id,
      merged: false,
      created: false,
      filesChanged: false,
      overflow: Array.from(merged).length,
      reason: `this session's single memory would reach ${Array.from(merged).length} characters (cap ${SESSION_MEMORY_MAX_CHARS}); compress it first (插件页 → 会话记忆 → 整理该会话) and save again`,
    }
  }
  single.content = merged
  single.category = category
  if (nextFiles.length > 0) single.files = nextFiles
  single.updatedAt = Date.now()
  single.mergedCount = Number(single.mergedCount ?? 1) + 1
  doc.updatedAt = single.updatedAt
  return { doc, id: single.id, merged: true, created: false, filesChanged }
}
```

同时让 `collapseSessionMemories` 保留文件并集——在它的 `doc.memories = [{ ... }]` 对象里加一行：

```js
    files: normalizeFiles(source.flatMap((memory) => normalizeFiles(memory.files))),
    category: newest.category ?? source[0].category ?? DEFAULT_CATEGORY,
```

**Step 4: 运行确认通过**

```sh
npm test
```

Expected: `6/6 passed, 0 failed`。

---

### Task 1.2：`save_memory` 接收 `files` 并落库

**Files:**
- Modify: `index.js` 的 `saveTool`（参数 `files`、输出 `fileCount`、执行体、索引 upsert）

**Step 1: 写失败测试**

追加到 `tests/files.test.mjs`：

```js
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
```

**Step 2: 运行确认失败**

```sh
npm test
```

Expected: 两条都 FAIL——第一条在 `saved.fileCount`（输出还没这个字段）或 `hit.sessions`（`files` 还没进索引）处失败；第二条在 `files` 数组为空处失败。

**Step 3: 先让测试能拿到工具（导出 `setupTools`）**

把 `function setupTools(ctx, config) {` 改为：

```js
export function setupTools(ctx, config, { skillGuide = false } = {}) {
```

（`{ skillGuide }` 参数在 Phase 2 才用；现在先加上，避免第二次改签名。）

**Step 4: 实现 tool 参数与输出**

在 `saveTool` 的 `parameters` 里、`profileSection` 之后加：

```js
      files: {
        type: 'array',
        description: 'Files this memory concerns, so "which memory touched this file" stays answerable (the paths are full-text indexed). Omit when the memory has no file scope.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            action: { type: 'string', enum: ['read', 'modified'] },
          },
        },
      },
```

`output.schema.properties` 里加：

```js
          fileCount: { type: 'number' },
```

**Step 5: 实现执行体**

在 `const content = String(args.content ?? '').trim()` 之后加：

```js
      // v2.20: file coordinates ride with the memory (read vs modified matters
      // for "what changed here before"; a later edit upgrades a read).
      const files = normalizeFiles(args.files)
```

把 `const outcome = mergeIntoSessionMemory(doc, content, saveCategory)` 改为：

```js
        const outcome = mergeIntoSessionMemory(doc, content, saveCategory, files)
```

把「已包含则直接返回」的分支替换为：

```js
        if (outcome.created === false && outcome.merged === false) {
          // A repeated fact still contributes coordinates: persist the file list
          // and refresh the derived index instead of pretending nothing happened.
          const record = doc.memories.at(-1)
          if (outcome.filesChanged === true) {
            await writeSessionMemory(config, sessionId, doc)
            await indexUpsert(config, {
              sessionId,
              memoryId: record.id,
              category: record.category,
              content: record.content,
              createdAt: record.createdAt,
              files: record.files,
            })
          }
          return {
            stored: false,
            ...(sessionId !== null ? { sessionId } : {}),
            trigger,
            reason: outcome.reason,
            total: doc.memories.length,
            ...(record !== undefined && Array.isArray(record.files) ? { fileCount: record.files.length } : {}),
          }
        }
```

把主索引 upsert 补上 files：

```js
        await indexUpsert(config, {
          sessionId,
          memoryId: record.id,
          category: record.category,
          content: record.content,
          createdAt: record.createdAt,
          files: record.files,
        })
```

在最终 return 里加：

```js
        fileCount: Array.isArray(doc?.memories.at(-1)?.files) ? doc.memories.at(-1).files.length : 0,
```

**Step 6: 让 `recall_memory` 把 files 返回（写入端不够，读端要看得见）**

`recallTool.output.schema` 的 session memory item 里加：

```js
                      files: {
                        type: 'array',
                        items: {
                          type: 'object',
                          additionalProperties: false,
                          properties: {
                            path: { type: 'string' },
                            action: { type: 'string' },
                          },
                        },
                      },
```

`execute` 里有三处构造 `sessionRows` 的 memory 对象，都要带上 files：

1. FTS 命中分支：记忆是从索引行重建的，files 要从会话文件按 id 取回来：

```js
            for (const [sid, memories] of bySession) {
              const doc = await readSessionMemory(config, sid)
              sessionRows.push({
                sessionId: sid,
                title: doc && typeof doc.title === 'string' ? doc.title : '',
                memories: memories.map((memory) => ({
                  ...memory,
                  files: normalizeFiles(doc?.memories?.find((row) => String(row.id) === memory.id)?.files),
                })),
              })
            }
```

2. 索引不可用时的 JSON 扫描分支，以及 3. 无 query 的直读分支：在 `.map((m) => ({ id..., content..., category..., createdAt... }))` 里加一行：

```js
                  files: normalizeFiles(m.files),
```

**Step 7: 运行**

```sh
npm test
```

Expected: 仍 FAIL——`rebuild` 还不认识 files（Step 4 的 save 已把 files 写进 JSON，但 FTS 的 `files` 列还不存在），所以 `recall` 的 FTS 分支命中 0 条。这是**预期状态**，Task 1.3 收口。

---

### Task 1.3：派生索引加 `files` 列（含自愈迁移）

**Files:**
- Modify: `search-index.js`（建表、`upsert`、`rebuild`、`search`）
- Modify: `index.js`（`indexUpsert` 透传 files）
- Test: `tests/search-index.test.mjs`

**Step 1: 写失败测试**

`tests/search-index.test.mjs`：

```js
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
```

**Step 2: 运行确认失败**

```sh
npm test
```

Expected: 首个用例 FAIL（`files` 列不存在，`rebuild` 插入时报错被静默吞掉 → `inserted: 0`）。

**Step 3: 实现建表与自愈**

`search-index.js` 里把建表段替换为：

```js
    db.exec('CREATE TABLE IF NOT EXISTS mem_meta ('
      + 'memoryId TEXT PRIMARY KEY,'
      + 'sessionId TEXT,'
      + 'category TEXT,'
      + 'createdAt INTEGER)')
    // v2.20: `files` is a new column on the derived index. The store is
    // rebuildable, so a stale table is dropped and recreated instead of migrated
    // in place; getSearchIndex() awaits rebuild() right after opening.
    try { db.exec('ALTER TABLE mem_meta ADD COLUMN files TEXT') } catch { /* already present */ }
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS mem_idx USING fts5("
      + "content, files, sessionId UNINDEXED, memoryId UNINDEXED, category UNINDEXED, createdAt UNINDEXED,"
      + " tokenize='trigram')")
    const indexColumns = (() => {
      try { return db.prepare('PRAGMA table_info(mem_idx)').all().map((row) => String(row.name)) } catch { return [] }
    })()
    if (!indexColumns.includes('files')) {
      db.exec('DROP TABLE mem_idx')
      db.exec("CREATE VIRTUAL TABLE mem_idx USING fts5("
        + "content, files, sessionId UNINDEXED, memoryId UNINDEXED, category UNINDEXED, createdAt UNINDEXED,"
        + " tokenize='trigram')")
    }
```

在 `clear()` 之前加两个函数声明（**用 `function` 声明而不是 `const` 箭头**，这样提升顺序不会成为 bug）：

```js
  /** One path per line: the indexed text form of a file list (actions stay in mem_meta). */
  function filesText(files) {
    if (!Array.isArray(files)) return ''
    return files
      .map((file) => {
        if (typeof file === 'string') return file
        return file !== null && typeof file === 'object' && typeof file.path === 'string' ? file.path : ''
      })
      .filter((path) => path.length > 0)
      .join('\n')
  }
```

`upsert` 替换为：

```js
  const upsert = ({ sessionId, memoryId, category, content, createdAt, files }) => {
    try {
      const text = String(content ?? '')
      if (!text.trim()) return
      db.prepare('DELETE FROM mem_idx WHERE memoryId = ?').run(String(memoryId ?? ''))
      db.prepare('INSERT OR REPLACE INTO mem_meta (memoryId, sessionId, category, createdAt, files)'
        + ' VALUES (?, ?, ?, ?, ?)').run(
        String(memoryId ?? ''),
        String(sessionId ?? ''),
        String(category ?? 'general'),
        Number(createdAt ?? 0),
        JSON.stringify(Array.isArray(files) ? files : []),
      )
      db.prepare('INSERT INTO mem_idx (content, files, sessionId, memoryId, category, createdAt)'
        + ' VALUES (?, ?, ?, ?, ?, ?)').run(
        text,
        filesText(files),
        String(sessionId ?? ''),
        String(memoryId ?? ''),
        String(category ?? 'general'),
        Number(createdAt ?? 0),
      )
    } catch {
      /* degrade silently */
    }
  }
```

`rebuild` 内两处改造：

```js
      const stmtMeta = db.prepare('INSERT OR REPLACE INTO mem_meta (memoryId, sessionId, category, createdAt, files) VALUES (?, ?, ?, ?, ?)')
      const stmtIdx = db.prepare('INSERT INTO mem_idx (content, files, sessionId, memoryId, category, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
```

以及循环体：

```js
          stmtMeta.run(String(m.id ?? ''), sid, String(m.category ?? 'general'), Number(m.createdAt ?? 0), JSON.stringify(Array.isArray(m.files) ? m.files : []))
          stmtIdx.run(String(m.content), filesText(m.files), sid, String(m.id ?? ''), String(m.category ?? 'general'), Number(m.createdAt ?? 0))
```

`search` 的 projection 与 LIKE 分支：

```js
    const projection = 'content, files, sessionId, memoryId, category, createdAt'
```

```js
    // LIKE fallback (substring across content OR indexed file paths, CJK-safe).
    try {
      const rows = db.prepare(
        `SELECT ${projection} FROM mem_idx WHERE (content LIKE ? OR files LIKE ?)${tail} ORDER BY createdAt DESC LIMIT ?`
      ).all(`%${q}%`, `%${q}%`, ...args, limit)
      return rows
    } catch (err) {
      throw err
    }
```

**Step 4: `index.js` 透传 files**

```js
async function indexUpsert(config, { sessionId, memoryId, category, content, createdAt, files }) {
  try {
    const index = await getSearchIndex(config)
    if (index === null) return
    index.upsert({ sessionId, memoryId, category, content, createdAt, files })
  } catch {
    /* degrade silently */
  }
}
```

**Step 5: 运行**

```sh
npm test
```

Expected: 全绿（`8/8` 起）。若 `files search` 仍为空，检查 `getSearchIndex` 的「rebuild 失败判定」：`sawMemories && inserted === 0` 会把索引降级为 null，此时 `indexSearch` 返回 null，recall 走 JSON 扫描——测试是独占新库，不应触发。

**Step 6: 快照**

```sh
cp index.js index.js.bak-v2.20.0-wip
```

---

### Task 1.4：导出/导入、桥接编辑、`/dream` 都不丢 `files`

**Files:**
- Modify: `index.js`（`buildExportBundle`、`applyImport`、`applyStoreOps` 的 `memory.replace`、`draftToSessionMemories`）
- Test: `tests/files.test.mjs`（追加 bundle 往返用例）

**Step 1: 写失败测试**

追加：

```js
import { buildExportBundle, parseExportBundle, planImport } from '../index.js'

test('an export bundle round-trips files through import', async () => {
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
```

**Step 2: 运行确认失败**

```sh
npm test
```

Expected: FAIL，`expected [{"path":"index.js",...}], got undefined`。

**Step 3: 实现**

`buildExportBundle` 的 memories 映射里加一行（保持字段顺序稳定，校验和是稳定序列化）：

```js
        ...(Array.isArray(memory.files) && memory.files.length > 0 ? { files: memory.files } : {}),
```

`applyImport` 的 `incoming.memories` 映射里加：

```js
        files: normalizeFiles(memory.files),
```

`applyImport` 的 merge 分支把文件传下去：

```js
      outcome = mergeIntoSessionMemory(doc, String(memory.content ?? ''), memory.category ?? DEFAULT_CATEGORY, memory.files)
```

`applyStoreOps` 的 `memory.replace` 里，`next` 对象加：

```js
          files: normalizeFiles(single?.files),
```

`draftToSessionMemories` 里，`memory` 对象加：

```js
    files: normalizeFiles(source.flatMap((memory) => normalizeFiles(memory.files))),
```

**Step 4: 运行**

```sh
npm test
```

Expected: 全绿。

**Step 5: 手工冒烟（真库只读检查，不写）**

```sh
DSH_HOME=${DSH_HOME:-$HOME/.dsh} node --input-type=module -e '
const { DatabaseSync } = await import("node:sqlite")
const db = new DatabaseSync(process.env.DSH_HOME + "/memory/memory.db")
console.log(db.prepare("PRAGMA table_info(mem_idx)").all().map((row) => row.name).join(","))
db.close()'
```

Expected: **改代码之前**是 `content,sessionId,memoryId,category,createdAt`（本机实测如此，18 个会话）；**新版插件跑过一次 recall/save 之后**应变成 `content,files,sessionId,...`——这一步同时验证自愈迁移在真库上生效。`files` 仍然缺席就说明 `getSearchIndex` 判定索引不可用并被降级了，去日志里找 `node:sqlite` 相关报错。

---

## Phase 2（P1）：检索用法移进 skill

**目标（可验收）**：三个常驻描述从 2,792 → < 1,800 字符（实测 1,715，−39%），skill 在会话 skill 目录里可见并按需加载；宿主无 skills 服务时回退到**修好插值的**完整长文（2,813），并保证不再出现未展开占位符。

### Task 2.1：`skill.js`

**Files:**
- Create: `skill.js`
- Modify: `package.json`（`files` 数组加 `skill.js`）

**Step 1: 写失败测试**

`tests/skill.test.mjs`：

```js
import { test, assert, assertEqual } from './lib/harness.mjs'
import { MEMORY_SKILL } from '../skill.js'

test('the skill name is kebab-case and the catalog summary stays small', () => {
  assert(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(MEMORY_SKILL.name), MEMORY_SKILL.name)
  assert([...MEMORY_SKILL.description].length <= 240, `description ${[...MEMORY_SKILL.description].length}`)
  assert([...MEMORY_SKILL.whenToUse].length <= 240, `whenToUse ${[...MEMORY_SKILL.whenToUse].length}`)
})

test('the skill body documents every retrieval level and its cost', () => {
  for (const needle of ['recall_memory', 'load_session_memory', 'timeline', 'files', 'scope']) {
    assert(MEMORY_SKILL.content.includes(needle), `body mentions ${needle}`)
  }
})
```

**Step 2: 运行确认失败**

```sh
npm test
```

Expected: FAIL，`Cannot find module '../skill.js'`。

**Step 3: 写 skill.js**

```js
/**
 * The retrieval protocol, kept out of the tool descriptions (v2.20).
 *
 * Tool descriptions are re-sent with every request; this body is loaded on
 * demand through the skills service, so the expensive guidance lives here and
 * only the catalog line (name + description) rides in the system prompt.
 * `buildToolDescriptions` in index.js points at MEMORY_SKILL.name.
 *
 * @module dsh-structured-memory/skill
 */

export const MEMORY_SKILL = {
  name: 'structured-memory',
  description:
    'Cross-session memory: how to find what a past session concluded (index -> recall -> load), what each level costs, and when a save is warranted.',
  whenToUse:
    'Before asking the user to repeat something from an earlier session, before loading a whole session memory, or when deciding whether the current work is worth saving.',
  content: [
    '# Cross-session memory: retrieval protocol',
    '',
    'What is ALREADY in your context: the <user_profile> block and the compact global',
    'index (one line per past session). What is NOT: any session\'s full memory —',
    'including the session you are in.',
    '',
    'Read one level at a time and stop as soon as the level answers the question.',
    '',
    '| Level | Call | Cost | Use when |',
    '|---|---|---|---|',
    '| 0 | already injected (profile + index) | paid once per change | deciding whether a session is relevant at all |',
    '| 1 | `recall_memory({ query })` | ~50–150 tokens per hit | you have a distinctive token: a path, identifier, error string, decision name |',
    '| 2 | `recall_memory({ scope: \'session\', sessionId })` | the whole session memory, may be thousands of tokens | level 1 shows the right session but the excerpt is not enough |',
    '| 3 | `load_session_memory({ sessionId })` | same size, and it stays in the conversation | you must keep reasoning over that session for many steps |',
    '| T | `recall_memory({ scope: \'timeline\', sessionId })` | one line per neighbouring session | you need what came before or after one moment |',
    '',
    '## Rules',
    '',
    '1. Prefer level 1. `load_session_memory` injects permanently for the rest of the',
    '   session; a recall result is disposable. When in doubt, recall first and load only',
    '   if you still need more.',
    '2. Query with the most distinctive token you have: `index.js`, an error string, a',
    '   ticket number. Queries of 3+ characters use the FTS5 trigram index; shorter',
    '   queries (including 2-character Chinese words) fall back to a substring scan, so',
    '   both work — but a longer, more specific token is what keeps the result set small.',
    '3. File paths are indexed. `recall_memory({ query: \'search-index.js\' })` returns the',
    '   memories that read or modified that file; each hit carries',
    '   `files: [{ path, action }]` where action is `read` or `modified`.',
    '4. `scope: \'all\'` merges profile + global index + session memories. Use it only when',
    '   you do not yet know which tier holds the answer; it is the widest and slowest read.',
    '5. `scope: \'timeline\'` anchors on a `sessionId` and returns the window of sessions',
    '   around it (`limit` counts rows, not rows per side). Without a sessionId it returns',
    '   the most recent window. Use it to reconstruct "what was happening just before this".',
    '6. `category` filters accept the closed vocabulary',
    '   `decision | bugfix | security | preference | general`. Older memories may still',
    '   carry a free-form label (the editor is a free-form escape hatch), so filter by',
    '   the five values first and fall back to a query if that returns nothing.',
    '',
    '## When a save is warranted',
    '',
    'A save is an event, not a judgement: the user asked to remember, the user accepted',
    'a deliverable, a trade-off was settled that cannot be re-derived, or an existing',
    'memory was corrected. Progress, TODOs, repository/docs content and guesses are not',
    'events. The session keeps exactly ONE memory, so a second save rewrites it — write',
    'conclusions, current state, coordinates and a pointer to the process document, not',
    'the narrative that produced them.',
    '',
    '## Privacy and delegation',
    '',
    'Anything inside `<private>…</private>` is removed before storage: the span stays in',
    'the conversation but never reaches the store, the index or an export bundle.',
    'Delegated subagents may recall and load, but `save_memory` / `forget_memory` refuse',
    'them — the delegating agent owns the write.',
  ].join('\n'),
}
```

**Step 4: 运行**

```sh
npm test
```

Expected: `10/10 passed`。

**Step 5: 把 `skill.js` 加进 npm 包**

`package.json` 的 `files` 数组改为：

```json
  "files": [
    "index.js",
    "client.js",
    "search-index.js",
    "skill.js",
    "cordis.patch.yml",
    "README.md",
    "LICENSE"
  ],
```

---

### Task 2.2：在 `apply()` 里注册（可选服务，失败即回退）

**Files:**
- Modify: `index.js`（`import { MEMORY_SKILL }`、`registerMemorySkill`、`apply`）

**Step 1: 写失败测试**

追加到 `tests/skill.test.mjs`：

```js
import { registerMemorySkill } from '../index.js'

test('registerMemorySkill registers once and reports availability', () => {
  const calls = []
  const effects = []
  const ctx = {
    get: (key) => (key === 'skills' ? { register: (skill) => { calls.push(skill); return () => {} } } : undefined),
    effect: (fn) => { effects.push(fn) },
  }
  assertEqual(registerMemorySkill(ctx), true)
  assertEqual(calls.length, 1)
  assertEqual(calls[0].name, MEMORY_SKILL.name)
  assertEqual(calls[0].content, MEMORY_SKILL.content)
  assertEqual(calls[0].source, 'runtime')
  assertEqual(effects.length, 1, 'the disposer is registered as an effect')
})

test('registerMemorySkill degrades when the host has no skills service', () => {
  assertEqual(registerMemorySkill({ get: () => undefined, effect: () => {} }), false)
})

test('registerMemorySkill survives a throwing registry (duplicate name on reload)', () => {
  const ctx = { get: () => ({ register: () => { throw new Error('duplicate') } }), effect: () => {} }
  assertEqual(registerMemorySkill(ctx), false)
})
```

**Step 2: 运行确认失败**

```sh
npm test
```

Expected: FAIL，`registerMemorySkill is not a function`。

**Step 3: 实现**

顶部 import 加：

```js
import { MEMORY_SKILL } from './skill.js'
```

在 `setupTools` 之前加：

```js
/**
 * Register the retrieval skill (v2.20). The skills service is optional: without
 * it the tools keep their long descriptions, so nothing is lost but tokens.
 * A duplicate registration (plugin reload) throws in some hosts; that is a
 * fallback case, not an error worth failing plugin startup over.
 */
export function registerMemorySkill(ctx) {
  const skills = typeof ctx?.get === 'function' ? ctx.get('skills') : undefined
  if (skills === undefined || skills === null || typeof skills.register !== 'function') return false
  try {
    const dispose = skills.register({
      ...MEMORY_SKILL,
      source: 'runtime',
      invocation: { modelInvocable: true, userInvocable: true },
    })
    if (typeof ctx.effect === 'function' && typeof dispose === 'function') ctx.effect(() => dispose)
    return true
  } catch {
    return false
  }
}
```

`apply()` 改为：

```js
  const skillGuide = registerMemorySkill(ctx)
  setupTools(ctx, config, { skillGuide })
```

**Step 4: 运行**

```sh
npm test
```

Expected: 全绿（13 条左右）。

---

### Task 2.3：描述瘦身（保留回退长文）

**Files:**
- Modify: `index.js`（新增 `buildToolDescriptions`，四个 `defineTool` 改用它）

**Step 1: 写失败测试**

追加到 `tests/skill.test.mjs`：

```js
import { buildToolDescriptions } from '../index.js'

test('compact descriptions fit the budget and keep every hard gate', () => {
  const compact = buildToolDescriptions({ skillGuide: true })
  const long = buildToolDescriptions({ skillGuide: false })

  assert([...compact.save].length <= 1300, `save ${[...compact.save].length}`)
  assert([...compact.recall].length <= 320, `recall ${[...compact.recall].length}`)
  assert([...compact.load].length <= 220, `load ${[...compact.load].length}`)

  for (const trigger of ['user-request', 'acceptance', 'decision', 'correction']) {
    assert(compact.save.includes(trigger), `compact save keeps trigger ${trigger}`)
  }
  for (const gate of ['evidence', 'keyPoint', 'profileUpdate', 'profileSection', 'ONE memory']) {
    assert(compact.save.includes(gate), `compact save keeps ${gate}`)
  }
  assert(compact.save.includes(MEMORY_SKILL.name), 'compact save points at the skill')
  assert(compact.recall.includes(MEMORY_SKILL.name), 'compact recall points at the skill')

  // The fallback must stay the long text: it is what a host without skills gets.
  assert([...long.save].length >= 2600, `long save ${[...long.save].length}`)
  assert(long.save.includes('DO NOT CALL IT'), 'fallback keeps the exclusion list')

  const total = (d) => [...d.save].length + [...d.recall].length + [...d.load].length
  assert(total(compact) < total(long) * 0.6, `${total(compact)} vs ${total(long)}`)
})
```

**Step 2: 运行确认失败**

```sh
npm test
```

Expected: FAIL，`buildToolDescriptions is not a function`。

**Step 3: 搬迁长描述（不要重打）**

1. 把 `saveTool` 现在的整段 `description: "..."`（**双引号字面量**，末尾是未展开的 `${SAVE_MEMORY_CONTENT_RULE}`）剪切到模块级常量 `LONG_SAVE_DESCRIPTION`，并**删掉末尾那个占位符**（规则改由 `buildToolDescriptions` 显式拼接——这正是本次要修的缺陷）。
2. 把 `recallTool` 的 description 原文剪到 `LONG_RECALL`，`loadSessionTool` 的剪到 `LONG_LOAD`。
3. `saveTool` / `recallTool` / `loadSessionTool` 的 `description:` 分别改为 `descriptions.save` / `descriptions.recall` / `descriptions.load`。

**Step 3b: 加入函数**

```js
/**
 * Model-facing tool descriptions (v2.20).
 *
 * `save_memory` used to carry 2,009 characters in every request, 26 of which
 * were a literal `${SAVE_MEMORY_CONTENT_RULE}` that never expanded — the
 * 831-character content rule never reached the model at all.
 * (2,009 of source plus the 831-character content rule). With a skills service
 * the long form moves into MEMORY_SKILL and only the gates stay inline; without
 * one the previous text is served unchanged, so an older host loses nothing.
 */
export function buildToolDescriptions({ skillGuide = false } = {}) {
  if (!skillGuide) {
    return {
      save: `${LONG_SAVE_DESCRIPTION}${SAVE_MEMORY_CONTENT_RULE}`,
      recall: LONG_RECALL,
      load: LONG_LOAD,
    }
  }
  return {
    save: "Save a long-term memory that must survive this session. The session keeps exactly ONE memory: this call rewrites it (deduplicated append) and keeps its index entry — call again whenever new durable facts appear. CALL ONLY WHEN AN EVENT HAPPENED, passing that trigger: 'user-request' (user asked to remember), 'acceptance' (user accepted a deliverable), 'decision' (a trade-off was settled that cannot be re-derived), 'correction' (an existing memory was corrected). acceptance/decision/correction also require evidence — a verbatim quote or a verifiable artifact (path, command, hash, number); without it, do not save. Never save for progress, TODOs, repo/docs content, or guesses. keyPoint: one dense conclusion, ≤50 chars (≤100 for unbreakable tokens); no document paths. files: paths this memory concerns. category: decision | bugfix | security | preference | general. PROFILES: also pass profileUpdate + profileSection (identity | work | personal | technical | style) when the memory carries stable user information. Subagents are read-only. <private>…</private> spans are removed before storage. Retrieval protocol and cost per level: load the structured-memory skill.",
    recall: "Search or list saved memories. scope: 'profile' | 'global' | 'session' | 'all' (default) | 'timeline' (sessions around an anchor). Full session memories are NOT auto-injected: query here for any detail, including this session's. File paths are indexed. Protocol: load the structured-memory skill.",
    load: "Load a PAST session's FULL memory into this conversation (expensive — prefer recall_memory with a query first). Load the structured-memory skill for the retrieval protocol.",
  }
}
```

> `<private>` 与 `category` 的措辞在 Phase 3/4 落地前就已经写进描述——这是有意的：描述是契约，先声明再实现，避免两次改同一行。但**测试断言只在对应 Phase 加**，否则会红。

**Step 4: 接进 `setupTools`**

签名在 Task 1.2 已经改过（`{ skillGuide = false } = {}`），这里只加一行并替换三个引用：

```js
export function setupTools(ctx, config, { skillGuide = false } = {}) {
  const descriptions = buildToolDescriptions({ skillGuide })
  const maxMemoriesPerSession = config.maxMemoriesPerSession ?? DEFAULT_MAX_MEMORIES_PER_SESSION
```

三个工具改用 `description: descriptions.save` / `descriptions.recall` / `descriptions.load`。`forget_memory` 保持原文（262 字符，不值得改）。

**Step 5: 运行并核对字符数**

```sh
npm test
node --import ./tests/lib/register.mjs -e "
import('./index.js').then((m) => {
  const c = m.buildToolDescriptions({ skillGuide: true })
  const l = m.buildToolDescriptions({ skillGuide: false })
  const n = (d) => [...d.save].length + [...d.recall].length + [...d.load].length
  console.log('compact', [...c.save].length, [...c.recall].length, [...c.load].length, 'total', n(c))
  console.log('long   ', [...l.save].length, [...l.recall].length, [...l.load].length, 'total', n(l))
})"
```

Expected: `compact 1237 306 172 total 1715` / `long 2813 555 228 total 3596`（±2 字符允许；差得多说明长文搬运时改了字，或规则没拼上）。

**Step 6: 版本号升到 2.20.0**

```sh
node -e "
const fs = require('fs')
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'))
p.version = '2.20.0'
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n')
"
# index.js: const PLUGIN_VERSION = '2.20.0'
```

**Step 7: 快照**

```sh
cp index.js index.js.bak-v2.20.0
```

---

## Phase 3（P2）：类型化记忆

**目标（可验收）**：模型写入的 `category` 落在 5 值枚举（别名与中英同义词都认），存量数据与编辑器输入不被改写；`/dream` 合成后类型按优先级保留；安全类记忆丢锚点时应用被**代码**拒绝（不是提示词劝阻）。

### Task 3.1：`normalizeCategory` 与写入路径

**Files:**
- Modify: `index.js`（常量 + `normalizeCategory`；`save_memory` 两处 category）
- Test: `tests/categories.test.mjs`

**Step 1: 写失败测试**

```js
import { test, assert, assertEqual } from './lib/harness.mjs'
import { normalizeCategory, MEMORY_CATEGORIES } from '../index.js'

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
```

**Step 2: 运行确认失败**

```sh
npm test
```

Expected: FAIL，`normalizeCategory is not a function`。

**Step 3: 实现**

放在 `SAVE_TRIGGERS` 附近：

```js
/**
 * Closed vocabulary for a memory's category (v2.21). Model-originated writes are
 * normalized onto it; stored and imported values are never rewritten (the editor
 * stays a free-form escape hatch, and old data keeps its label).
 */
export const MEMORY_CATEGORIES = ['decision', 'bugfix', 'security', 'preference', 'general']

/** The order that decides which type survives a synthesis (most consequential first). */
const CATEGORY_PRIORITY = ['security', 'decision', 'bugfix', 'preference', 'general']

/** Aliases accepted from the model, including the free labels earlier versions used. */
const CATEGORY_ALIASES = {
  decision: 'decision', '决策': 'decision', '决定': 'decision', '取舍': 'decision',
  bugfix: 'bugfix', bug: 'bugfix', fix: 'bugfix', '修复': 'bugfix', '缺陷': 'bugfix',
  security: 'security', '安全': 'security', '隐私': 'security',
  preference: 'preference', preferences: 'preference', style: 'preference',
  '偏好': 'preference', '习惯': 'preference', '风格': 'preference',
  general: 'general', '通用': 'general', '其他': 'general',
}

/** Normalize a model-originated category; unknown labels fall back. */
export function normalizeCategory(raw, fallback = DEFAULT_CATEGORY) {
  const key = String(raw ?? '').trim().toLowerCase()
  if (key.length === 0) return fallback
  return CATEGORY_ALIASES[key] ?? fallback
}
```

`save_memory` 里两处：

```js
        const saveCategory = normalizeCategory(args.category)
```

```js
      const category = normalizeCategory(args.category)
```

**Step 4: 运行**

```sh
npm test
```

Expected: 全绿。

---

### Task 3.2：`/dream` 的类型优先级与安全硬闸

**Files:**
- Modify: `index.js`（`draftToSessionMemories`、`evaluateSessionConsolidation`、`applyConsolidation`、`SESSION_CONSOLIDATION_INSTRUCTION`）
- Test: `tests/categories.test.mjs`（追加）

**Step 1: 写失败测试**

```js
import { evaluateSessionConsolidation } from '../index.js'

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

test('draftToStore normalizes a model label but keeps an operator label', async () => {
  const { draftToStore } = await import('../index.js')
  const entries = [
    { id: 'g1', sessionId: 's1', title: 'A', keyPoints: 'kp', category: '教务', lastActivity: 1 },
  ]
  const sections = { identity: [], work: [], personal: [], technical: [], style: [] }
  const omitted = draftToStore(sections, entries, { global: [{ fromIds: ['g1'], title: 'A', keyPoints: 'kp' }] })
  assertEqual(omitted.entries[0].category, '教务', 'operator label survives an omitted category')

  const relabeled = draftToStore(sections, entries, { global: [{ fromIds: ['g1'], title: 'A', keyPoints: 'kp', category: '修复' }] })
  assertEqual(relabeled.entries[0].category, 'bugfix', 'model alias is normalized')
})

test('a non-security session is not gated by lostSecurity', () => {
  const doc = { sessionId: 's', memories: [{ id: 'm1', content: '见 ops/rotate.md', category: 'decision', createdAt: 1 }] }
  const evaluation = evaluateSessionConsolidation(doc, { content: '已决定', category: 'decision' })
  assertEqual(evaluation.lostSecurity.length, 0)
})
```

**Step 2: 运行确认失败**

```sh
npm test
```

Expected: 第 1、2 条 FAIL（`evaluation.next[0].category` 仍是 `preference`；`lostSecurity` 是 `undefined`）。

**Step 3: 实现分类优先级**

`draftToSessionMemories` 里，把 `const category = ...` 整段替换为：

```js
  const sourceCategories = source.map((memory) => normalizeCategory(memory.category))
  const inherited = CATEGORY_PRIORITY.find((type) => sourceCategories.includes(type)) ?? DEFAULT_CATEGORY
  const requested = normalizeCategory(draft.category, inherited)
  // A session that holds a security fact stays security-typed: the label is the
  // only thing telling a later reader that compression may not drop details.
  const category = sourceCategories.includes('security')
    ? 'security'
    : (requested === DEFAULT_CATEGORY ? inherited : requested)
```

**Step 4: 实现安全锚点闸**

`evaluateSessionConsolidation` 里，在 `const kept = new Set(...)` 之前加：

```js
  // v2.21: a security-typed memory may be compressed, but not lose an anchor —
  // the one type whose coordinates are not negotiable.
  const lostSecurity = []
  for (const memory of before.filter((entry) => normalizeCategory(entry.category) === 'security')) {
    for (const anchor of collectAnchors(String(memory.content ?? ''))) {
      if (!afterText.toLowerCase().includes(anchor)) lostSecurity.push(anchor)
    }
  }
```

return 对象里加：

```js
    lostSecurity,
```

`applyConsolidation` 里，在 `lostCritical` 那段之后加：

```js
  // Security facts get their own hard gate in every scope: a draft that drops
  // their coordinates is refused, not merely reported.
  if (Array.isArray(evaluation.lostSecurity) && evaluation.lostSecurity.length > 0) {
    return Promise.resolve({
      ok: false,
      code: 'lost-security',
      message: `整理会丢失安全类记忆的关键标识，已拒绝应用：${evaluation.lostSecurity.slice(0, 8).join('、')}`,
    })
  }
```

**Step 5: 注入层整理也归一化（但保留操作者标签）**

`draftToStore` 里的那一行改为：

```js
      category: normalizeCategory(
        String(row.category ?? source.category ?? DEFAULT_CATEGORY),
        source.category ?? DEFAULT_CATEGORY,
      ),
```

第二个参数是 fallback：源条目若是操作者手填的 `教务`，模型又没给 category，就仍是 `教务`（不会被打成 `general`）；只有模型真的给出可识别的新标签时才改写。

**Step 6: 提示词同步（不是硬闸，但要让模型知道规则）**

`SESSION_CONSOLIDATION_INSTRUCTION` 数组末尾加：

```js
  '9. **类型保留**：分类只能是 decision / bugfix / security / preference / general；合成结果取素材中优先级最高的类型（security > decision > bugfix > preference > general）。',
  '   **security 类的事实即使被压缩也不得丢失其中的路径、命令、编号等标识**——这是硬闸，丢锚点会被拒绝应用；',
  '   decision 保留取舍与理由，bugfix 保留根因与修法，preference 可压成一句。',
```

**Step 7: 运行**

```sh
npm test
```

Expected: 全绿。

**Step 8: 钉住「只归一化模型写入」这条边界**

追加（导出/导入不归一化，这是操作者的逃生口；防止后人「顺手统一」）：

```js
test('export never rewrites a stored category', async () => {
  const { buildExportBundle } = await import('../index.js')
  const bundle = buildExportBundle({
    version: 'test', profile: null, entries: [], at: 1, options: {},
    sessions: [{ sessionId: 's', title: null, origin: null, memories: [{ id: 'm', content: 'x', category: '教务', createdAt: 1 }] }],
  })
  assertEqual(bundle.sessions[0].memories[0].category, '教务')
})
```

**Step 9: 快照**

```sh
cp index.js index.js.bak-v2.20.0
```

---

## Phase 4（P2）：`<private>` 排除标记

**目标（可验收）**：带 `<private>…</private>` 的保存，其秘密内容**不出现在** `sessions/*.json`、`global.json`、`memory.db`（FTS 行）、导出 bundle；未闭合的 `<private>` 丢弃其后全部文本；四条写入路径（save / 桥接 / dream 草稿 / 导入）共用同一实现。

### Task 4.1：`stripPrivateSpans`

**Files:**
- Modify: `index.js`
- Test: `tests/private.test.mjs`

**Step 1: 写失败测试**

```js
import { test, assert, assertEqual } from './lib/harness.mjs'
import { stripPrivateSpans } from '../index.js'

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
```

**Step 2: 运行确认失败**

```sh
npm test
```

Expected: FAIL，`stripPrivateSpans is not a function`。

**Step 3: 实现**

```js
/**
 * Excise `<private>…</private>` spans (v2.21). Users mark content that belongs to
 * the conversation but never to the store; scrubbing runs before the dedup and
 * length checks so a redacted save is judged on what actually persists.
 * An unterminated opener drops the rest of the text — a half-tag must never leak
 * what it was meant to hide.
 */
export function stripPrivateSpans(text) {
  const source = String(text ?? '')
  const complete = /<private(?:\s[^>]*)?>[\s\S]*?<\/private\s*>/gi
  const matched = source.match(complete) ?? []
  const rest = source.replace(complete, '')
  const danglingAt = rest.search(/<private[\s>]/i)
  const kept = danglingAt < 0 ? rest : rest.slice(0, danglingAt)
  return {
    text: kept.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim(),
    removed: matched.length + (danglingAt < 0 ? 0 : 1),
  }
}
```

**Step 4: 运行**

```sh
npm test
```

Expected: 全绿。

---

### Task 4.2：`save_memory` 写入前脱敏

**Files:**
- Modify: `index.js`（save 执行体、输出 `redacted`）

**Step 1: 写失败测试**

追加到 `tests/private.test.mjs`。断言必须走**真实的 `save_memory.execute`** 并扫描**整个记忆根目录**——只测 `stripPrivateSpans` 无法证明它被接上了：

```js
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tempStore, memoryTools, fakeAgent } from './lib/harness.mjs'

/** Every byte the plugin persisted for this store, concatenated. */
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
```

（`storeBytes` 会扫到 `memory.db` 的二进制页，`readFile(..., 'utf8')` 对二进制是安全的有损解码——只要断言「子串不存在」，这就足够；不要因此断言内容相等。）

**Step 2: 实现**

`save_memory` 执行体开头（`const content = ...` 之前）改为：

```js
      // v2.21: <private> spans exist in the conversation, never in the store.
      const scrubbedContent = stripPrivateSpans(String(args.content ?? ''))
      const content = scrubbedContent.text.trim()
      if (!content) {
        throw new Error(scrubbedContent.removed > 0
          ? 'save_memory: content is empty after removing <private> spans — nothing to store'
          : 'save_memory: content is required')
      }
```

四个文本字段一次扫完（每个字段只扫一遍，`redacted` 是总数）：

```js
      const scrubbed = {
        content: stripPrivateSpans(args.content),
        keyPoint: stripPrivateSpans(args.keyPoint),
        title: stripPrivateSpans(args.title),
        profile: stripPrivateSpans(args.profileUpdate),
      }
      const redacted = scrubbed.content.removed + scrubbed.keyPoint.removed
        + scrubbed.title.removed + scrubbed.profile.removed
```

后续取值改为 `normalizeKeyPoint(scrubbed.keyPoint.text, content)`、`scrubbed.title.text.trim()`、`scrubbed.profile.text.trim()`；`content` 仍来自 `scrubbed.content.text.trim()`（Step 2 第一段）。

最终 return 加：

```js
        redacted,
```

`output.schema.properties` 加：

```js
          redacted: { type: 'number' },
```

**Step 3: 运行**

```sh
npm test
```

Expected: 全绿。

---

### Task 4.3：其余三条写入路径同样脱敏

**Files:**
- Modify: `index.js`（`applyStoreOps` 的 `profile.replace` / `global.update` / `memory.replace`、`draftToSessionMemories`、`applyImport`）

**Step 1: 写失败测试**

```js
test('a synthesis draft cannot reintroduce a private span', async () => {
  const { evaluateSessionConsolidation } = await import('../index.js')
  const doc = { sessionId: 's', memories: [{ id: 'm1', content: '结论', category: 'general', createdAt: 1 }] }
  const evaluation = evaluateSessionConsolidation(doc, { content: '结论 <private>sk-999</private> 尾巴', category: 'general' })
  assert(!evaluation.next[0].content.includes('sk-999'))
})
```

**Step 2: 实现**

- `profile.replace`：`const text = stripPrivateSpans(typeof point === 'string' ? point.trim() : '').text`。
- `global.update`：`entry.title = stripPrivateSpans(op.title).text.trim().slice(0, BRIDGE_TITLE_MAX_CHARS)`，`entry.keyPoints` 同样先脱敏。
- `memory.replace`：`const content = stripPrivateSpans(String(op.content ?? '')).text.trim()`（空则走既有的 `content is required` reject）。
- `draftToSessionMemories`：`content: stripPrivateSpans(content).text.slice(0, BRIDGE_POINT_MAX_CHARS)`。
- `applyImport`：`content: stripPrivateSpans(String(memory.content ?? '')).text`，`category` 不动。

**Step 3: 运行**

```sh
npm test
```

Expected: 全绿。

**Step 4: 文档一句话（README 在 Phase 6 统一改，这里只改描述）**

确认 `buildToolDescriptions({skillGuide:true}).save` 含 `<private>`（Task 2.3 已写入）。加断言：

```js
test('the compact save description documents the private convention', async () => {
  const { buildToolDescriptions } = await import('../index.js')
  assert(buildToolDescriptions({ skillGuide: true }).save.includes('<private>'))
})
```

**Step 5: 快照**

```sh
cp index.js index.js.bak-v2.21.0-wip
```

---

## Phase 5（P2）：timeline 视图

**目标（可验收）**：`recall_memory({scope:'timeline', sessionId:'<anchor>', limit:3})` 返回锚点前后各 1 条共 3 条，锚点行 `anchor:true`；无锚点时返回最近窗口；只有会话文件没有索引条目的会话也能出现在时间轴上（`linked:false`）。

### Task 5.1：`buildTimeline` 派生

**Files:**
- Modify: `index.js`（`listSessionSummaries` 加 `fileCount`；新增 `timelineRows` / `buildTimeline`）
- Test: `tests/timeline.test.mjs`

**Step 1: 写失败测试**

```js
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, assert, assertEqual, tempStore } from './lib/harness.mjs'
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
      memories: [{ id: `m-${session.id}`, content: `memory ${session.id}`, category: 'general', createdAt: session.at, files: [{ path: `${session.id}.js`, action: 'modified' }] }],
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
```

**Step 2: 运行确认失败**

```sh
npm test
```

Expected: FAIL，`buildTimeline is not a function`。

**Step 3: 实现**

`listSessionSummaries` 的 `rows.push({...})` 里加：

```js
      fileCount: memories.reduce((total, memory) => total + (Array.isArray(memory.files) ? memory.files.length : 0), 0),
```

在 `readSessionDetail` 之前加：

```js
/**
 * Timeline rows are derived, never stored (v2.21): the global index supplies the
 * key point and last activity, the session files supply the fallback time and the
 * file count. A session present in only one of the two stores still appears — that
 * asymmetry is exactly what the link audit reports.
 */
function timelineRows(entries, summaries) {
  const rows = new Map()
  for (const entry of entries) {
    const sessionId = String(entry.sessionId ?? '')
    if (sessionId.length === 0) continue
    rows.set(sessionId, {
      sessionId,
      title: String(entry.title ?? ''),
      keyPoint: String(entry.keyPoints ?? ''),
      category: String(entry.category ?? ''),
      at: Number(entry.lastActivity ?? 0),
      linked: false,
      files: 0,
    })
  }
  for (const summary of summaries) {
    const row = rows.get(summary.sessionId)
    if (row === undefined) {
      rows.set(summary.sessionId, {
        sessionId: summary.sessionId,
        title: summary.title ?? '',
        keyPoint: '',
        category: summary.category ?? '',
        at: Number(summary.updatedAt ?? 0),
        linked: false,
        files: Number(summary.fileCount ?? 0),
      })
      continue
    }
    row.linked = true
    if (row.at === 0) row.at = Number(summary.updatedAt ?? 0)
    row.files = Number(summary.fileCount ?? 0)
  }
  return [...rows.values()].sort((a, b) => b.at - a.at)
}

/**
 * The sessions around one anchor (or the newest window when no anchor is given).
 * `limit` counts rows, not rows per side.
 */
export async function buildTimeline(config, { anchorSessionId = null, limit = 9 } = {}) {
  const rows = timelineRows(await readGlobal(config), await listSessionSummaries(config))
  const size = Math.max(1, Math.min(25, Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 9))
  const anchor = typeof anchorSessionId === 'string' && anchorSessionId.length > 0 ? anchorSessionId : null
  const anchorIndex = anchor === null ? 0 : rows.findIndex((row) => row.sessionId === anchor)
  const start = anchorIndex < 0 ? 0 : Math.max(0, anchorIndex - Math.floor((size - 1) / 2))
  return {
    timeline: rows.slice(start, start + size).map((row) => ({ ...row, anchor: anchor !== null && row.sessionId === anchor })),
    anchorSessionId: anchor ?? '',
    anchorFound: anchor === null ? rows.length > 0 : anchorIndex >= 0,
  }
}
```

**Step 4: 运行**

```sh
npm test
```

Expected: 全绿。

---

### Task 5.2：接进 `recall_memory`

**Files:**
- Modify: `index.js`（`recallTool` 的 scope 描述、输出 schema、`execute` 早返回）

**Step 1: 写失败测试**

追加到 `tests/timeline.test.mjs`。**必须走 `recall_memory.execute`**：`buildTimeline` 在 Task 5.1 已经绿了，只有工具路由还没接，所以这条测试现在会红——这正是我们要的红。

```js
import { memoryTools, tempStore } from './lib/harness.mjs'

test('scope=timeline routes recall_memory to the timeline builder', async () => {
  const store = await tempStore()
  try {
    await seed(store) // 复用 Task 5.1 的 seed：5 个会话，at = 1000..5000
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
```

**Step 2: 运行确认失败**

```sh
npm test
```

Expected: FAIL——`scope` 还不认识 `timeline`，`wantProfile/wantGlobal/wantSessions` 全为 false，返回值是 `{ global: [], sessions: [] }`，`result.timeline` 为 `undefined`。

**Step 3: 实现**

`recallTool.parameters.scope` 描述改为：

```js
      scope: { type: 'string', description: "Filter scope: 'profile' | 'global' | 'session' | 'all' (default) | 'timeline' (the window of sessions around one anchor)." },
```

`sessionId` 描述改为：

```js
      sessionId: { type: 'string', description: "Optional session id: for scope=session returns only that session's full memories; for scope=timeline it is the anchor." },
```

`execute` 在 `const limit = ...` 之后加：

```js
      if (scope === 'timeline') {
        return await buildTimeline(config, {
          anchorSessionId: typeof args.sessionId === 'string' ? args.sessionId : null,
          limit,
        })
      }
```

`output.schema.properties` 加：

```js
          timeline: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                title: { type: 'string' },
                keyPoint: { type: 'string' },
                category: { type: 'string' },
                at: { type: 'number' },
                linked: { type: 'boolean' },
                files: { type: 'number' },
                anchor: { type: 'boolean' },
              },
            },
          },
          anchorSessionId: { type: 'string' },
          anchorFound: { type: 'boolean' },
```

**Step 4: 运行**

```sh
npm test
```

Expected: 全绿。

---

### Task 5.3：把 timeline 写进 skill

**Files:**
- Modify: `skill.js`（`content` 第 5 条已含 timeline，确认措辞与实现一致）
- Test: `tests/skill.test.mjs`（已有 `timeline` 断言）

**Step 1: 核对**

`skill.js` 的规则 5 应写着「`limit` counts rows, not rows per side」，与 `buildTimeline` 一致。若实现里窗口中心取整是 `Math.floor((size-1)/2)`（偏前），把措辞改成「the anchor is centred when the window is odd; the extra row goes to the newer side」——以实现为准，不要写反。

**Step 2: 运行**

```sh
npm test
```

Expected: 全绿。

**Step 3: 快照 + 版本号 2.21.0**

```sh
cp index.js index.js.bak-v2.21.0
# package.json version 与 index.js 的 PLUGIN_VERSION 均改为 2.21.0
```

---

## Phase 6：文档、版本号与验收

### Task 6.1：README

**Files:**
- Modify: `README.md`

**Step 1: 更新「存储」**

在 `sessions/<sessionId>.json` 那一行后面补：

```md
  - 单条记忆字段：`id` / `content` / `category` / `createdAt` / `updatedAt` / `mergedCount` / `files?`（`files: [{path, action:'read'|'modified'}]`，多次保存取并集，`modified` 覆盖 `read`，上限 50 条）
```

**Step 2: 更新「工具」表**

`save_memory` 行补 `files`；`recall_memory` 行补 `scope=timeline` 与「按文件路径召回」：

```md
| `save_memory` | 存记忆到当前会话层 + 维护全局条目（须带 `trigger`，自动保存须带 `evidence`；可带 `profileUpdate` 合并画像、`files` 记录文件坐标；`<private>` 内容入库前剔除） |
| `recall_memory` | 按 scope（profile/global/session/all/timeline）+ query（FTS5/LIKE，覆盖正文与文件路径）检索记忆 |
```

**Step 3: 新增四节**

插在「注入策略」之后：

```md
## 检索协议与 skill（v2.20）

检索用法长文从工具描述移进 runtime skill `structured-memory`（`skill.js`），由 `ctx.skills.register` 注册：会话 skill 目录里只留一行描述，正文按需加载。宿主没有 skills 服务时自动回退到旧长描述，行为不变。

实测常驻描述（save + recall + load）：2,792 → 1,715 字符（−39%）；`save_memory` 单条 2,009 → 1,237。

## 类型化记忆（v2.21）

`category` 对**模型写入**归一化为 `decision | bugfix | security | preference | general`（认中英别名，含旧标签）。存量数据、导入 bundle 与插件页手写值不被改写——页面是逃生口，README 与界面均如此说明。

`/dream` 的类型差异是硬闸而不是提示词：合成结果里 `security` 类记忆一旦丢失路径/命令/编号等锚点，应用阶段直接拒绝（`lost-security`）；合成本身的类型取素材中最高优先级（security > decision > bugfix > preference > general）。

## 隐私标记（v2.21）

会话里的 `<private>…</private>` 只在对话中存在：保存、插件页写入、`/dream` 草稿、导入四条路径共用 `stripPrivateSpans`，入库前切除。未闭合的 `<private>` 会丢弃其后全部文本（半截标签不允许泄漏）。已入库内容不会被回溯脱敏——需要清理请用 `forget_memory` 或页面删除。

## 时间轴（v2.21）

`recall_memory({scope:'timeline', sessionId:'<锚点>', limit:9})` 返回锚点周围的会话窗口（`limit` 是**行数**）。数据完全派生：`global.json` 的 `lastActivity` + `sessions/*.json` 的 `updatedAt`/`files`，不新增存储。只有会话文件、没有索引条目的会话也会出现（`linked:false`），这与 `?doctor=1` 的链接审计口径一致。
```

**Step 4: 版本历史补两行**

```md
| v2.20 | 记忆采集文件坐标（`files`，FTS 覆盖路径）；检索长文移入 runtime skill `structured-memory`，常驻工具描述 2,792 → 1,715 字符；修掉未展开的 `${SAVE_MEMORY_CONTENT_RULE}`；`memory.db` 新增 `files` 列并自愈重建 |
| v2.21 | `category` 收敛为五值枚举（模型写入归一化、存量不改写）；`/dream` 类型优先级 + 安全类丢锚点硬闸；`<private>` 四条写入路径统一剔除；`recall_memory` 新增 `scope=timeline` |
```

**Step 5: 更新「运行要求」里的测试说明**

在 README 的「运行要求」之后新增这一节（下面的围栏是四反引号，因为正文里含一段 `sh` 代码块）：

````md
## 测试

```sh
npm test   # node --import ./tests/lib/register.mjs ./tests/run.mjs
```

测试不需要 DSH 运行时：`tests/lib/register.mjs` 用 `module.registerHooks` 把 `@deepseek-ai/*` 映射到 `tests/lib/stubs/`。所有用例使用临时记忆根（`memoryDir`），**不读写 `~/.dsh/memory`**。
````

### Task 6.2：`tests/README.md`

**Files:**
- Modify: `tests/README.md`

替换全文：

```md
# tests/

2026-10-21 目录迁移时发现：此前维护的十二套回归测试（约 289 项断言）只存在于 `/tmp`，随系统清理丢失。

2026-10-23 起，本目录以最小脚手架重建（不是原 289 断言的替代品）：

- `lib/register.mjs` —— 用 `module.registerHooks` 把 `@deepseek-ai/schemastery` / `dsh-tools` / `dsh-llm` 映射到 `lib/stubs/`，因此 `index.js` 能在 DSH 之外被 import；
- `lib/harness.mjs` —— `test` / `assert` / `assertEqual` / `tempStore`；
- `run.mjs` —— 导入全部 `*.test.mjs`，串行执行，10s 超时，失败退出码非 0。

约定：
- 测试放在本目录，随源码一起保存，**不再放 `/tmp`**；
- 每条用例用 `tempStore()` 建临时记忆根（`memoryDir`），**不碰真库**；
- 宁可断言「坏实现会失败」的东西（按文件召回、秘密不落盘、丢锚点被拒），不要只断言「没抛异常」。
```

### Task 6.3：端到端验收

**Step 1: 本地全量**

```sh
npm test
```

Expected: 全部 `ok`，退出码 0。

**Step 2: 挂载后验证（必须在挂载了本插件的会话里做，本会话没有）**

在插件目录被 profile 加载并重启 DSH 之后：

1. `cordis_inspect_query({platform:'host', provider:'Tool', method:'listTools'})` → 找到 `save_memory`，描述长度应约 1,237（不再 2,009，也不应出现 `${`）。
2. 会话 skill 目录里应出现 `structured-memory`（`skill` 工具可加载）。
3. 一次真实保存：

```text
save_memory({ trigger:'decision', evidence:'docs/claude-mem-comparison.md', category:'决策',
  keyPoint:'记忆库只做文件坐标与类型化', files:[{path:'index.js',action:'modified'}],
  content:'... <private>不该入库的片段</private> ...' })
```

4. 真库抽查（只读）：

```sh
jq -r '.memories[0].files' ~/.dsh/memory/sessions/*.json | head
sqlite3 ~/.dsh/memory/memory.db "select files from mem_meta order by createdAt desc limit 3"
grep -rl '不该入库的片段' ~/.dsh/memory/ || echo 'private: clean'
```

Expected: `files` 为 `[{...}]`；FTS `files` 列有路径；`grep` 无命中。

5. 按文件召回：`recall_memory({query:'index.js'})` 应命中刚保存的记忆。
6. 时间轴：`recall_memory({scope:'timeline', sessionId:'<当前会话>', limit:5})` 应有 5 行、锚点行 `anchor:true`。

**Step 3: 发布**

`npm publish` 不在本计划内自动执行（需要 npm 凭据与用户确认）。版本号改完后由操作者决定发布时机。

---

## 风险与回滚

| 风险 | 触发条件 | 处置 |
|---|---|---|
| FTS 索引重建放大 IO | 库很大（当前 76 KB，18 会话，可忽略） | `getSearchIndex` 每次进程启动 await 一次 rebuild，现状已如此；若库超过几 MB 再考虑增量重建 |
| skill 名称冲突（同 profile 另一个插件也叫 `structured-memory`） | `register` 抛错 | `registerMemorySkill` 捕获并返回 false，工具回退长描述 |
| 描述瘦身后模型少存/错存 | 观察 1–2 周 | 把 `skillGuide` 回退开关做成配置项（`Config` 加 `memorySkill: z.boolean()`，默认 true）——**本计划不做**，先观察；真要回退就把 `apply` 里的 `true` 换成 `false` |
| `category` 归一化把旧标签变 `general` | 模型下次保存该会话时 | 存量文件不重写；只有该会话再次被模型保存时才归一化。导出/导入不归一化 |
| `<private>` 误伤正常文本（正文真出现 `<private>` 字样） | 用户写文档讲这个标记 | 未闭合即丢弃后文属于「宁可多删」的安全侧；README 已写明 |
| timeline 行数语义误解（`limit` 是行数） | 用户以为是每侧行数 | 描述与 skill 都写明；测试钉住 |
| 插件目录无 git，改坏难回 | 任意编辑失误 | 每个 Phase 前 `.bak-v<version>` 快照；新代码全测试覆盖 |

**回滚**：`cp index.js.bak-v2.20.0 index.js`（或 `v2.21.0`），版本号改回，`rm memory.db` 让索引重建（派生库，删了只会丢索引不会丢记忆）。

---

## 明确不在本计划内

- **P0 的整套回归重建**（12 套 / 289 断言，按 `tests/README.md` 的既定顺序：注入契约 → 单条制 → 会话桥 → 导出导入 → jsdom 数据页）。本计划 Task 0 只造脚手架，不做这五套。**后续进展**：v2.21.1 已补完前四套（95 条用例，逐套变异验证），仅 jsdom 页面交互暂缓，见 `tests/README.md`。
- 插件页时间轴 UI（已确认只做工具层）。
- 全量捕获 / 每轮自动 summarize / Chroma 向量 / 常驻 worker / 账户体系（对比文档第五节「不该抄的」）。
- SQLite 升为唯一事实源。
- `files` 进入注入层（token 预算原因，见设计决策）。
- 已入库内容的历史脱敏（只做写入端）。
