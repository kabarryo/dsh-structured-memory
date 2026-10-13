/**
 * dsh-memory v2.2 — two-tier cross-session memory + user profile + FTS5 search + auto backup.
 *
 * Storage:
 *
 *   1. Profile tier (profile.json): a structured user profile distilled from
 *      long-term history (identity / work / personal / technical / style).
 *      A compact <user_profile> block is delivered as DSH runtime context —
 *      re-rendered at every assembly but materialized ONLY when it changed —
 *      so the model always has the user's stable context at no per-step cost.
 *      save_memory gains a
 *      profileUpdate judgment: when the model saves a memory that also
 *      conveys profile-worthy user information, it passes profileUpdate +
 *      profileSection and the plugin merges the point into profile.json
 *      (deduplicated) — profile updates ride along with memory saves.
 *   2. Global tier (global.json): one ultra-compact entry per historical
 *      session — title, keyPoints (default ≤ 50 chars), keywords. This tier
 *      rides in the same runtime-context snapshot, giving the model a cheap
 *      index of all past sessions without their details.
 *   3. Session tier (sessions/<sessionId>.json): the full, detailed memories
 *      of one session, stored per-session. NOT injected automatically — the
 *      session's own message history is already in context, so re-injecting
 *      <session_memory> would be redundant (and would silently exceed the
 *      byte budget once memories grow). Full memories — this session's or
 *      another's — are retrieved on demand via recall_memory(query) or
 *      load_session_memory(sessionId).
 *
 * Search (v2.2): an optional derived FTS5 index (memory.db, node:sqlite,
 * zero new deps) accelerates recall_memory. JSON files remain the source of
 * truth; the index is rebuildable and degrades silently to substring recall
 * when sqlite is unavailable. See search-index.js.
 *
 * Backup (v2.2): profile/global/sessions are copied to
 * <memoryDir>/memory-backup/YYYY-MM-DD/ on startup and at most once per
 * autoBackupMin minutes (default daily); backupRetainDays (default 7) old
 * backups are pruned.
 *
 * Tools:
 *   - save_memory          : persist to the CURRENT session tier + maintain the global entry (+ optional profile merge / search upsert / backup trigger)
 *   - recall_memory        : search across profile/global/session tiers with scope filters (+ FTS5 when a query is given)
 *   - load_session_memory  : load a past session's FULL memory into this conversation (on demand)
 *   - forget_memory        : delete one memory entry or an entire session, with global sync + search index sync
 *
 * Policy (v2.3): delegated subagents receive the same injection (profile +
 * global index) as their parent, but their memory access is READ-ONLY —
 * save_memory / forget_memory refuse when the caller is a subagent (session
 * origin "subagent", or delegationDepth > 0); recall_memory and
 * load_session_memory stay available. Rationale: a child must not delete the
 * parent's memories, write memories nobody asked for, or race the parent on
 * global.json (read-modify-write without a lock). Disable with
 * `subagentMemoryReadOnly: false`.
 *
 * Legacy migration: a v1 memories.json (flat array) is split by sourceSession
 * once at startup when `migration` is enabled; the old file is renamed with a
 * .migrated-<ts> suffix (no data loss, no re-migration).
 *
 * @module dsh-memory
 */

import { mkdir, readFile, writeFile, rename, readdir, copyFile, rm, stat } from 'node:fs/promises'
import { readFileSync, statSync, existsSync } from 'node:fs'
import { dirname, resolve, join, basename, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm'
import { openSearchIndex } from './search-index.js'

export const name = 'dsh-structured-memory'
export const inject = ['agents', 'tools', 'systemPrompt']

const DEFAULT_CATEGORY = 'general'
const GLOBAL_KEY_POINT_MAX = 50
const GLOBAL_KEY_POINT_CRITICAL_MAX = 100
const DEFAULT_MAX_MEMORIES_PER_SESSION = 1000
const DEFAULT_INJECT_LIMIT = 20
const DEFAULT_MAX_INJECT_BYTES = 8192
const DEFAULT_RECALL_LIMIT = 50
/** Characters of a key point kept in the clipped index variant. */
const INDEX_KEY_POINT_CHARS = 24
/** Hard ceiling for a session's single memory, so a save can never grow it forever. */
const SESSION_MEMORY_MAX_CHARS = 16000
/** A forked session writes into its lineage's memory unless this is turned off. */
const DEFAULT_INHERIT_FORK_MEMORY = true
/**
 * Content rule for the session tier: the injected tiers stay small, and every
 * session memory is retrieved later at the cost of a recall — so it holds
 * conclusions and pointers, never the process that produced them.
 */
export const SAVE_MEMORY_CONTENT_RULE = "CONTENT RULE: this session keeps ONE memory, and that memory is a durable reference — keep it to conclusions, current state, trade-offs that cannot be re-derived, coordinates (paths, commands, numbers) and a pointer to where the process record lives (a project document or repository file). Process narrative, measured figures, pitfall stories, changelogs and commit hashes belong in that document, NOT here; write the pointer once instead of copying the detail." 
/* ------------------------- transfer (export / import) -------------------- */
const TRANSFER_PATH = '/api/dsh-memory-transfer'
const TRANSFER_DIR = 'transfer'
const PLUGIN_VERSION = '2.19.2'
const EXPORT_KIND = 'dsh-structured-memory-export'
const EXPORT_FORMAT = 1
const TRANSFER_MAX_BYTES = 5 * 1024 * 1024

function transferDirOf(config) {
  return join(memoryRootOf(config), TRANSFER_DIR)
}

/**
 * Roots the operator may read/write bundles from. The bridge is loopback-only,
 * but "loopback" still means any local process, so paths are confined to the
 * user's own home (plus the transfer directory and /tmp) instead of the whole
 * filesystem, and exports never overwrite an existing file unless asked.
 */
function allowedTransferRoots(config) {
  const home = homedir()
  return [transferDirOf(config), home, join(home, 'Desktop'), join(home, 'Documents'), join(home, 'Downloads'), '/tmp']
}

function confinePath(config, rawPath) {
  const expanded = String(rawPath ?? '').trim().replace(/^~(?=\/|$)/, homedir())
  const target = resolve(expanded)
  const allowed = allowedTransferRoots(config).map((root) => resolve(root))
  if (!allowed.some((root) => target === root || target.startsWith(`${root}${sep}`))) {
    throw new Error(`路径必须位于以下目录内：${allowed.join('、')}`)
  }
  return target
}

/** Where an export should land: the transfer directory, an explicit file, or a directory. */
function resolveExportTarget(config, options) {
  const dest = typeof options.dest === 'string' && options.dest.trim().length > 0 ? options.dest.trim() : null
  const dirOption = typeof options.dir === 'string' && options.dir.trim().length > 0 ? options.dir.trim() : null
  if (dest === null && dirOption === null) return { dir: transferDirOf(config), file: null }
  if (dest !== null) {
    const target = confinePath(config, dest)
    if (!target.endsWith('.json')) throw new Error('导出目标必须以 .json 结尾')
    const parent = dirname(target)
    if (!existsSync(parent)) throw new Error(`目标目录不存在：${parent}`)
    return { dir: parent, file: basename(target) }
  }
  const dir = confinePath(config, dirOption)
  if (!existsSync(dir)) throw new Error(`目标目录不存在：${dir}`)
  return { dir, file: null }
}

/** Reveal one file in the desktop file manager (macOS `open -R`); best effort. */
function revealPath(path) {
  if (process.platform !== 'darwin') return false
  try {
    execFile('open', ['-R', path], () => {})
    return true
  } catch {
    return false
  }
}

/** Deterministic serialization: the checksum must not depend on key order. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function exportChecksum(payload) {
  return `sha256:${createHash('sha256').update(stableStringify(payload)).digest('hex')}`
}

/** Assemble the machine-readable bundle. `sessions` is the主体; entries derive from it. */
export function buildExportBundle({ version, profile, entries, sessions, options, at }) {
  const payload = {
    kind: EXPORT_KIND,
    format: EXPORT_FORMAT,
    exportedAt: new Date(at).toISOString(),
    source: { plugin: name, version, memoryRoot: 'memory' },
    options,
    counts: {
      profilePoints: profile === null ? 0 : PROFILE_SECTIONS.reduce((total, section) => total + (profile.sections[section] ?? []).length, 0),
      globalEntries: entries.length,
      sessions: sessions.length,
      memories: sessions.reduce((total, session) => total + session.memories.length, 0),
    },
    profile: profile === null ? null : { sections: profile.sections, updatedAt: profile.updatedAt ?? null },
    global: entries.map((entry) => ({
      id: entry.id,
      sessionId: entry.sessionId,
      title: entry.title ?? '',
      keyPoints: entry.keyPoints ?? '',
      category: entry.category ?? DEFAULT_CATEGORY,
      lastActivity: entry.lastActivity ?? null,
    })),
    sessions: sessions.map((session) => ({
      sessionId: session.sessionId,
      title: session.title ?? null,
      origin: isRecord(session.origin) ? session.origin : null,
      memories: session.memories.map((memory) => ({
        id: String(memory.id),
        content: String(memory.content ?? ''),
        category: memory.category ?? DEFAULT_CATEGORY,
        createdAt: Number.isFinite(memory.createdAt) ? memory.createdAt : Date.now(),
        ...(Number.isFinite(memory.updatedAt) ? { updatedAt: memory.updatedAt } : {}),
        ...(Number.isFinite(memory.mergedCount) ? { mergedCount: memory.mergedCount } : {}),
      })),
    })),
  }
  return { ...payload, checksum: exportChecksum(payload) }
}

/** Validate a bundle: kind, format, checksum, shape. Never trusts the file. */
export function parseExportBundle(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, code: 'unparsable', message: `不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!isRecord(parsed)) return { ok: false, code: 'malformed', message: '顶层不是对象' }
  if (parsed.kind !== EXPORT_KIND) return { ok: false, code: 'wrong-kind', message: `kind 不是 ${EXPORT_KIND}（若为仅索引预览格式，导入端拒绝）` }
  if (parsed.format !== EXPORT_FORMAT) return { ok: false, code: 'wrong-format', message: `format=${String(parsed.format)}，本版只接受 ${EXPORT_FORMAT}` }
  const { checksum, ...payload } = parsed
  if (typeof checksum !== 'string' || checksum !== exportChecksum(payload)) {
    return { ok: false, code: 'checksum-mismatch', message: '校验和不匹配：文件可能被截断或手工修改' }
  }
  if (!Array.isArray(parsed.sessions) || !Array.isArray(parsed.global)) return { ok: false, code: 'malformed', message: 'global / sessions 必须是数组' }
  return { ok: true, bundle: parsed }
}

/**
 * Import plan: what would change. Pure input → decision, so it can be shown as a
 * dry-run before anything is written.
 */
export function planImport({ bundle, targetProfile, targetSessionIds, onExisting }) {
  const profileAdds = []
  const profileSkips = []
  if (isRecord(bundle.profile) && isRecord(bundle.profile.sections)) {
    for (const section of PROFILE_SECTIONS) {
      const points = Array.isArray(bundle.profile.sections[section]) ? bundle.profile.sections[section] : []
      const existing = targetProfile?.sections?.[section] ?? []
      for (const point of points) {
        const text = String(point ?? '').trim()
        if (text.length === 0) continue
        if (profilePointCovered(existing, text)) profileSkips.push({ section, text })
        else profileAdds.push({ section, text })
      }
    }
  }
  const bundleSessionIds = new Set(bundle.sessions.map((session) => session.sessionId))
  const sessions = bundle.sessions.map((session) => ({
    sessionId: session.sessionId,
    memories: session.memories.length,
    chars: session.memories.reduce((total, memory) => total + String(memory.content ?? '').length, 0),
    mode: !targetSessionIds.has(session.sessionId)
      ? 'create'
      : onExisting === 'skip' ? 'skip' : onExisting === 'replace' ? 'replace' : 'merge',
  }))
  // Hard rule: an entry without its session in the same bundle can never be
  // imported (it would become an orphan entry and break the 1:1 contract).
  const rejectedEntries = bundle.global
    .filter((entry) => typeof entry.sessionId !== 'string' || !bundleSessionIds.has(entry.sessionId))
    .map((entry) => ({ id: entry.id, sessionId: entry.sessionId ?? null, title: entry.title ?? '' }))
  const bundleEntrySessions = new Set(bundle.global.map((entry) => entry.sessionId))
  const entriesToBuild = bundle.sessions.filter((session) => !bundleEntrySessions.has(session.sessionId)).map((session) => session.sessionId)
  return { profileAdds, profileSkips, sessions, rejectedEntries, entriesToBuild }
}

const DEFAULT_MAX_PROFILE_POINTS = 100
const DEFAULT_AUTO_BACKUP_MIN = 1440 // once per day
const DEFAULT_BACKUP_RETAIN_DAYS = 7
/** Delegated subagents may read memory but not write or delete it (v2.3). */
const DEFAULT_SUBAGENT_MEMORY_READ_ONLY = true
/**
 * Save triggers (v2.4): a closed list of *events that have occurred*. The
 * decision is then a fact to check against the transcript, not a judgement
 * about how valuable the content feels — "considering whether this is worth
 * remembering" is not a trigger, and that is what curbs mis-triggered saves.
 */
const SAVE_TRIGGERS = ['user-request', 'acceptance', 'decision', 'correction']
/** Every trigger except an explicit user request must cite an anchor (v2.4). */
const EVIDENCE_REQUIRED_TRIGGERS = ['acceptance', 'decision', 'correction']
/** Auto-saves must cite evidence unless this is turned off. */
const DEFAULT_SAVE_REQUIRE_EVIDENCE = true
/** Placement of the memory runtime-context snapshot (after DSH policy contexts). */
const MEMORY_CONTEXT_ORDER = 130
const PROFILE_SECTIONS = ['identity', 'work', 'personal', 'technical', 'style']
const PROFILE_SECTION_ALIASES = {
  身份: 'identity',
  工作: 'work',
  职责: 'work',
  个人: 'personal',
  技术: 'technical',
  风格: 'style',
  写作: 'style',
}

/** Plugin configuration (schemastery-validated). */
export const Config = z.object({
  memoryDir: z.string(),
  maxMemoriesPerSession: z.number(),
  injectLimit: z.number().step(1).min(1).volatile(),
  maxInjectBytes: z.number().step(1).min(1).volatile(),
  maxProfilePoints: z.number(),
  autoBackupMin: z.number(),
  backupRetainDays: z.number(),
  migration: z.boolean(),
  subagentMemoryReadOnly: z.boolean(),
  saveRequireEvidence: z.boolean(),
  inheritForkMemory: z.boolean(),
  consolidationProvider: z.string().volatile(),
  consolidationModel: z.string().volatile(),
  consolidationReasoningEffort: z.string().volatile(),
  consolidationMaxTokens: z.number(),
})

/**
 * Resolve the memory root: explicit config, then the DSH state directory.
 *
 * `$DSH_HOME` *is* the DSH state directory — it holds `profiles/`, `logs/`,
 * `storages/` — not the user's home. The store therefore hangs directly off it
 * (`$DSH_HOME/memory`). Treating it as a home appends a second `.dsh` and
 * silently splits the library into two stores; that was the v2.3 path bug.
 */
function memoryRootOf(config) {
  if (typeof config.memoryDir === 'string' && config.memoryDir.length > 0) {
    return resolve(config.memoryDir)
  }
  const stateDir = process.env.DSH_HOME
  if (typeof stateDir === 'string' && stateDir.length > 0) {
    return resolve(stateDir, 'memory')
  }
  const home = process.env.HOME || homedir()
  return resolve(home, '.dsh', 'memory')
}

/**
 * Startup note for the split-store failure mode: when a store also sits at the
 * legacy `<stateDir>/.dsh/memory` shape while the active root is elsewhere, say
 * so. A mis-resolved root then reports itself instead of failing silently.
 */
function noteMemoryRoot(config) {
  try {
    const root = memoryRootOf(config)
    const stateDir = process.env.DSH_HOME
    if (typeof stateDir !== 'string' || stateDir.length === 0) return
    const legacy = resolve(stateDir, '.dsh', 'memory')
    if (legacy !== root && existsSync(legacy)) {
      console.error(
        `[dsh-memory] stray store at ${legacy}; active memory root is ${root}`,
      )
    }
  } catch {
    /* diagnostics must never crash the host */
  }
}

function globalPathOf(root) {
  return join(root, 'global.json')
}

function profilePathOf(root) {
  return join(root, 'profile.json')
}

function sessionPathOf(root, sessionId) {
  return join(root, 'sessions', `${safeSessionId(sessionId)}.json`)
}

function backupPathOf(root) {
  return join(root, 'memory-backup')
}

/** Session ids come from DSH (uuid-like); sanitize defensively for filenames. */
function safeSessionId(sessionId) {
  const s = String(sessionId ?? '').trim()
  if (!s) return 'unknown'
  return s.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isErrno(err) {
  return typeof err === 'object' && err !== null && 'code' in err
}

/* ---------------------------------- IO ---------------------------------- */

/** Read a JSON array/object file; [] / {} on missing or corrupt. */
async function readJson(path, fallback) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if (isErrno(err) && err.code === 'ENOENT') return fallback
    throw err
  }
  if (!raw.trim()) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/** Atomically persist JSON (write temp + rename). */
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = resolve(tmpdir(), `dsh-memory-${randomUUID()}.json`)
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, path)
}

async function readGlobal(config) {
  return readJson(globalPathOf(memoryRootOf(config)), [])
}

async function writeGlobal(config, entries) {
  await writeJson(globalPathOf(memoryRootOf(config)), entries)
}

/**
 * Serialize global.json read-modify-write per memory root. Every session and
 * subagent of one DSH process shares the map — a per-root promise chain is
 * therefore enough to remove the lost-update race between concurrent
 * save_memory / forget_memory calls (previously a plain read → modify → rename).
 * Two separate DSH processes sharing one memory dir are NOT covered.
 */
const globalMutationChains = new Map()

function withGlobalLock(config, mutate) {
  const root = memoryRootOf(config)
  const previous = globalMutationChains.get(root) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(mutate)
  globalMutationChains.set(root, run.catch(() => {}))
  return run
}

async function readProfile(config) {
  const doc = await readJson(profilePathOf(memoryRootOf(config)), null)
  if (!isRecord(doc)) {
    const fresh = { version: 1, updatedAt: null, sections: {} }
    for (const section of PROFILE_SECTIONS) fresh.sections[section] = []
    return fresh
  }
  if (!isRecord(doc.sections)) doc.sections = {}
  for (const section of PROFILE_SECTIONS) {
    if (!Array.isArray(doc.sections[section])) doc.sections[section] = []
  }
  return doc
}

async function writeProfile(config, doc) {
  await writeJson(profilePathOf(memoryRootOf(config)), doc)
}

/* --------------------- sync reads (prompt-section path) ------------------ */
/* PromptContext.text must be synchronous, so the injection renderer uses    */
/* these sync readers behind an mtime+size stamp (see setupInjection).       */

/** Sync twin of readJson; [] / {} on missing or corrupt. */
function readJsonSync(path, fallback) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if (isErrno(err) && err.code === 'ENOENT') return fallback
    throw err
  }
  if (!raw.trim()) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function readGlobalSync(config) {
  return readJsonSync(globalPathOf(memoryRootOf(config)), [])
}

/** Sync twin of readProfile, including the fresh-document section seeding. */
function readProfileSync(config) {
  const doc = readJsonSync(profilePathOf(memoryRootOf(config)), null)
  if (!isRecord(doc)) {
    const fresh = { version: 1, updatedAt: null, sections: {} }
    for (const section of PROFILE_SECTIONS) fresh.sections[section] = []
    return fresh
  }
  if (!isRecord(doc.sections)) doc.sections = {}
  for (const section of PROFILE_SECTIONS) {
    if (!Array.isArray(doc.sections[section])) doc.sections[section] = []
  }
  return doc
}

/**
 * Freshness stamp for the two injected files (mtime + size). Any writer —
 * this session, another session, or a hand edit — changes it, so the cached
 * render is reused only while the files are untouched.
 */
function freshnessStamp(config) {
  const root = memoryRootOf(config)
  const stampOf = (path) => {
    try {
      const st = statSync(path)
      return `${st.mtimeMs}:${st.size}`
    } catch {
      return 'absent'
    }
  }
  return `${stampOf(profilePathOf(root))}|${stampOf(globalPathOf(root))}`
}

/**
 * Compose the injected text: user profile first (highest priority), then the
 * compact global index, trimmed from the back while over the byte budget.
 */
/**
 * Single source of truth for the injected text: which profile part and which index
 * variant actually fit the byte budget. Returns the parts so the page can price
 * them separately instead of re-deriving the choice.
 */
function pickInjection(profile, globalEntries, injectLimit, maxInjectBytes) {
  const bytes = (text) => Buffer.byteLength(text, 'utf8')
  const join = (parts) => parts.filter((part) => typeof part === 'string' && part.length > 0).join('\n')
  const profileText = renderUserProfile(profile)
  const variants = renderIndexVariants(globalEntries, injectLimit)
  if (variants.length === 0) {
    const text = join([profileText])
    return { profilePart: profileText ?? '', indexPart: '', text }
  }
  // Richest index variant that still fits alongside the profile.
  for (const variant of variants) {
    const candidate = join([profileText, variant])
    if (bytes(candidate) <= maxInjectBytes) return { profilePart: profileText ?? '', indexPart: variant, text: candidate }
  }
  // Even the stub does not fit: trim the profile down and keep the stub, because a
  // silently dropped index is exactly how memories become undiscoverable.
  const stub = variants[variants.length - 1]
  let profilePart = typeof profileText === 'string' ? profileText : ''
  const lines = profilePart.split('\n')
  if (lines.length > 9) profilePart = [...lines.slice(0, 3), '  - …', ...lines.slice(-2)].join('\n')
  return { profilePart, indexPart: stub, text: join([profilePart, stub]) }
}

export function composeInjection(profile, globalEntries, injectLimit, maxInjectBytes) {
  return pickInjection(profile, globalEntries, injectLimit, maxInjectBytes).text
}

/** True when the calling agent is a delegated subagent (child of another agent). */
function isSubagentAgent(agent) {
  const header = agent?.session?.header
  if (!isRecord(header)) return false
  if (header.origin === 'subagent') return true
  const depth = header.delegationDepth
  return typeof depth === 'number' && depth > 0
}

/**
 * v2.3 policy: delegated subagents get READ-ONLY memory. A child could
 * otherwise delete the parent's memories, write memories nobody asked for,
 * and race the parent on global.json (read-modify-write without a lock).
 * recall_memory / load_session_memory stay available to children.
 */
/** Remember the route the last memory-tool call ran on, for consolidation. */
let lastRoutedTarget = null
function rememberRoute(agent) {
  try {
    const routed = agent?.session?.requestHeader?.()?.config
    if (routed !== undefined && typeof routed.provider === 'string' && typeof routed.model === 'string') {
      lastRoutedTarget = { provider: routed.provider, model: routed.model }
    }
  } catch {
    /* routing history is best-effort */
  }
}

function assertMemoryWritable(config, agent, toolName) {
  const readOnly = config.subagentMemoryReadOnly ?? DEFAULT_SUBAGENT_MEMORY_READ_ONLY
  if (!readOnly) return
  if (!isSubagentAgent(agent)) return
  throw new Error(
    `${toolName}: delegated subagents have read-only memory access. Report what should be remembered `
    + 'to the delegating agent and let it own the write; do not retry from inside this subagent.',
  )
}

/** Normalize a section label: English key, or a Chinese alias. */
function normalizeProfileSection(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().toLowerCase()
  if (PROFILE_SECTIONS.includes(trimmed)) return trimmed
  if (PROFILE_SECTION_ALIASES[raw.trim()]) return PROFILE_SECTION_ALIASES[raw.trim()]
  return null
}

/** True if `point` is already covered by `existing` (exact or containment). */
function profilePointCovered(existing, point) {
  const p = point.trim().toLowerCase()
  if (!p) return true
  return existing.some((e) => {
    const s = String(e || '').trim().toLowerCase()
    if (!s) return false
    if (s === p) return true
    const short = s.length < p.length ? s : p
    const long = s.length < p.length ? p : s
    return long.includes(short) && short.length >= 4
  })
}

/**
 * Merge a profile-worthy point into profile.json. Returns the section it was
 * merged into, or null when the point is empty/duplicate/unknown-section.
 */
async function mergeProfilePoint(config, section, point) {
  const normalized = normalizeProfileSection(section)
  const text = typeof point === 'string' ? point.trim() : ''
  if (normalized === null || !text) return null
  const profile = await readProfile(config)
  const list = profile.sections[normalized]
  if (profilePointCovered(list, text)) return null
  list.push(text)
  profile.updatedAt = Date.now()
  await writeProfile(config, profile)
  return normalized
}

async function readSessionMemory(config, sessionId) {
  const doc = await readJson(sessionPathOf(memoryRootOf(config), sessionId), null)
  if (!isRecord(doc)) return null
  if (!Array.isArray(doc.memories)) doc.memories = []
  return doc
}

async function writeSessionMemory(config, sessionId, doc) {
  await writeJson(sessionPathOf(memoryRootOf(config), sessionId), doc)
}

async function listSessionFiles(config) {
  const dir = join(memoryRootOf(config), 'sessions')
  try {
    const names = await readdir(dir)
    return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5))
  } catch (err) {
    if (isErrno(err) && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return []
    throw err
  }
}

/* --------------------------- search index (v2.2) -------------------------- */

const searchIndexByRoot = new Map() // memoryRoot -> handle|null (null = disabled)
const backupStampByRoot = new Map() // memoryRoot -> last backup ms

/**
 * Lazy per-root singleton for the FTS5 search index. Returns the index handle
 * or null when unavailable (node:sqlite missing / open failed / disabled).
 */
async function getSearchIndex(config) {
  const root = memoryRootOf(config)
  if (searchIndexByRoot.has(root)) return searchIndexByRoot.get(root)
  const index = await openSearchIndex({ memoryDir: root })
  if (index === null) {
    searchIndexByRoot.set(root, null)
    return null
  }
  // Rebuild once, AWAITED: rebuild() clears the index before re-inserting, so
  // serving a search before it finishes returns nothing (observed: the first
  // query after a process restart came back empty while the rebuild ran).
  // Idempotent and cheap at current data volumes.
  let result = { inserted: 0, sawMemories: false }
  try {
    result = await index.rebuild()
  } catch {
    result = { inserted: 0, sawMemories: true }
  }
  // Silent rebuild failure: the store holds memories but none got indexed —
  // degrade to the JSON scan instead of serving permanently empty results.
  if (result.sawMemories && result.inserted === 0) {
    try { index.close() } catch { /* ignore */ }
    searchIndexByRoot.set(root, null)
    return null
  }
  searchIndexByRoot.set(root, index)
  return index
}

/** Upsert one memory record into the search index (no-op when unavailable). */
async function indexUpsert(config, { sessionId, memoryId, category, content, createdAt }) {
  try {
    const index = await getSearchIndex(config)
    if (index === null) return
    index.upsert({ sessionId, memoryId, category, content, createdAt })
  } catch {
    /* degrade silently */
  }
}

/** Remove one memory (or whole session) from the search index. */
async function indexRemove(config, { memoryId, sessionId }) {
  try {
    const index = await getSearchIndex(config)
    if (index === null) return
    if (typeof memoryId === 'string' && memoryId.length > 0) index.remove({ memoryId })
    if (typeof sessionId === 'string' && sessionId.length > 0) index.removeSession({ sessionId })
  } catch {
    /* degrade silently */
  }
}

/**
 * Search memories via FTS5 (+ LIKE fallback). Returns an array of hits, or
 * null when the index is unavailable (caller should fall back to a scan).
 */
async function indexSearch(config, query, opts) {
  try {
    const index = await getSearchIndex(config)
    if (index === null) return null
    return index.search(query, opts)
  } catch {
    return null
  }
}

/* ---------------------------- backup (v2.2) ------------------------------- */

/** Copy profile/global/sessions into memory-backup/YYYY-MM-DD/. */
async function runBackup(config) {
  const root = memoryRootOf(config)
  const destRoot = backupPathOf(root)
  const day = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const dest = join(destRoot, day)
  try {
    await mkdir(dest, { recursive: true })
  } catch {
    return
  }
  const sources = [profilePathOf(root), globalPathOf(root)]
  const sessionsDir = join(root, 'sessions')
  let sessionFiles = []
  try {
    sessionFiles = (await readdir(sessionsDir)).filter((n) => n.endsWith('.json'))
  } catch {
    sessionFiles = []
  }
  for (const f of sources) {
    try {
      await copyFile(f, join(dest, new Date().toISOString().replace(/[:.]/g, '-') + '-' + f.split(/[\\/]/).pop()))
    } catch {
      /* skip missing source */
    }
  }
  for (const f of sessionFiles) {
    try {
      await copyFile(join(sessionsDir, f), join(dest, `${new Date().toISOString().replace(/[:.]/g, '-')}-${f}`))
    } catch {
      /* skip */
    }
  }
  // Prune backups older than backupRetainDays.
  const retainDays = Number.isFinite(config.backupRetainDays) && config.backupRetainDays > 0
    ? Math.floor(config.backupRetainDays)
    : DEFAULT_BACKUP_RETAIN_DAYS
  try {
    const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000
    const days = (await readdir(destRoot)).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
    for (const d of days) {
      const ts = Date.parse(d)
      if (Number.isFinite(ts) && ts < cutoff) {
        await rmRecursive(join(destRoot, d))
      }
    }
  } catch {
    /* ignore prune errors */
  }
}

/** Recursive directory removal (backups only; no cross-filesystem risk). */
async function rmRecursive(p) {
  await rm(p, { recursive: true, force: true }).catch(() => {})
}

/**
 * Backup on startup and at most once per autoBackupMin (default daily).
 * autoBackupMin <= 0 disables automatic backup entirely.
 */
async function maybeBackup(config) {
  const intervalMin = Number.isFinite(config.autoBackupMin)
    ? config.autoBackupMin
    : DEFAULT_AUTO_BACKUP_MIN
  if (intervalMin <= 0) return
  const root = memoryRootOf(config)
  const now = Date.now()
  const stamp = backupStampByRoot.get(root) ?? 0
  if (now - stamp < intervalMin * 60 * 1000) return
  backupStampByRoot.set(root, now)
  try {
    await runBackup(config)
  } catch {
    /* degrade silently */
  }
}

/* ------------------------------ key points ------------------------------ */

/** Whether a text contains un-truncatable critical tokens (serial/key/address). */
function hasCriticalToken(text) {
  return /(?:https?:\/\/|[\w.-]+\.\w{2,}(?::\d{1,5})?(?:\/[\w./?=&%-]*)?)|(?:\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b)|(?:\b[A-Za-z0-9_-]{16,}\b)|(?:\b\d{1,3}(?:\.\d{1,3}){3}\b)/gi.test(text)
}

/** Count by Unicode code points ("字" counting for CJK-aware truncation). */
function charLen(text) {
  return Array.from(String(text)).length
}

/** Truncate to `max` code points; never mid-surrogate. */
function truncateChars(text, max) {
  const chars = Array.from(String(text))
  if (chars.length <= max) return text
  return chars.slice(0, max).join('')
}

/**
 * Normalize a keyPoint to the agreed budget: default ≤ 50 chars, but up to
 * 100 when it carries un-truncatable critical tokens (serial/key/address).
 */
function normalizeKeyPoint(rawKeyPoint, sourceContent) {
  const base = typeof rawKeyPoint === 'string' && rawKeyPoint.trim().length > 0
    ? rawKeyPoint.trim()
    : (typeof sourceContent === 'string' ? sourceContent.trim() : '')
  if (!base) return ''
  const cap = hasCriticalToken(base) ? GLOBAL_KEY_POINT_CRITICAL_MAX : GLOBAL_KEY_POINT_MAX
  return truncateChars(base, cap)
}

/**
 * Case/whitespace/punctuation-insensitive form used for duplicate detection
 * (v2.4 gate 3). Both sides are normalized the same way, so paraphrases of a
 * path or command still compare as equal.
 */
function normalizeMemoryText(text) {
  return String(text).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/* ------------------------------- rendering ------------------------------ */

/** Render the global index (all session entries) for injection. */
/**
 * Index block variants, richest first. EVERY entry is always listed, so the model
 * can never be unaware that a session exists; `injectLimit` now only decides how
 * many entries (most recently active first) carry their key points, and the byte
 * budget degrades the block step by step instead of dropping it.
 */
export function renderIndexVariants(entries, injectLimit) {
  if (!Array.isArray(entries) || entries.length === 0) return []
  const keyPointLimit = Number.isFinite(injectLimit) ? Math.max(0, Math.floor(injectLimit)) : entries.length
  const row = (entry, index, mode) => {
    const title = typeof entry.title === 'string' && entry.title.length > 0 ? entry.title : entry.sessionId
    const category = typeof entry.category === 'string' && entry.category.length > 0 ? entry.category : DEFAULT_CATEGORY
    const raw = typeof entry.keyPoints === 'string' ? entry.keyPoints.trim() : ''
    if (mode === 'title') return `[${index + 1}] (${category}) ${title}`
    if (raw.length === 0) return `[${index + 1}] (${category}) ${title}`
    if (mode === 'clip') {
      const clipped = raw.length > INDEX_KEY_POINT_CHARS ? `${Array.from(raw).slice(0, INDEX_KEY_POINT_CHARS).join('')}…` : raw
      return `[${index + 1}] (${category}) ${title} — ${clipped}`
    }
    return `[${index + 1}] (${category}) ${title} — ${raw}`
  }
  const withKeyPoints = (index) => index < keyPointLimit
  const wrap = (lines, note) => [
    '<system-reminder>',
    'The following global memory index lists every past session that has memories — nothing is omitted. Each entry is an ultra-compact summary; details live per-session.',
    note,
    '',
    '<global_memory_index>',
    ...lines,
    '</global_memory_index>',
    '</system-reminder>',
  ].join('\n')
  // `injectLimit` decides which entries carry key points; the rest keep their title
  // line so no session can fall out of sight. The three listed variants then only
  // differ in how much of each key point survives.
  const full = entries.map((entry, index) => row(entry, index, withKeyPoints(index) ? 'full' : 'title'))
  const clipped = entries.map((entry, index) => row(entry, index, withKeyPoints(index) ? 'clip' : 'title'))
  const titles = entries.map((entry, index) => row(entry, index, 'title'))
  const note = 'Use recall_memory with a query for a specific detail (cheap, full-text search across all sessions), or load_session_memory with a sessionId to load one session\'s full memory (can be thousands of tokens — prefer the query first).'
  const variants = [
    wrap(full, note),
    wrap(clipped, note),
    wrap(titles, note),
    [
      '<system-reminder>',
      `The global memory index holds ${entries.length} session entries and is too large to list in this budget. Call recall_memory(scope:"global") to list them, then load_session_memory(sessionId) for one session.`,
      '</system-reminder>',
    ].join('\n'),
  ]
  return variants.filter((text, index) => index === 0 || text !== variants[index - 1])
}

/** Render one session's full memories for injection. */
function renderSessionMemory(doc, sessionId) {
  if (!doc || !Array.isArray(doc.memories) || doc.memories.length === 0) return undefined
  const lines = doc.memories.map((m, i) => {
    const category = typeof m.category === 'string' && m.category.length > 0 ? m.category : DEFAULT_CATEGORY
    const content = typeof m.content === 'string' ? m.content : String(m.content)
    return `[${i + 1}] (${category}) ${content}`
  })
  const title = typeof doc.title === 'string' && doc.title.length > 0 ? doc.title : sessionId
  return [
    '<system-reminder>',
    `Full memory of session "${title}" (${sessionId}):`,
    '',
    '<session_memory>',
    ...lines,
    '</session_memory>',
    '</system-reminder>',
  ].join('\n')
}

/** Render the structured user profile as a compact injection block. */
function renderUserProfile(profile) {
  if (!isRecord(profile) || !isRecord(profile.sections)) return undefined
  const lines = []
  for (const section of PROFILE_SECTIONS) {
    const points = Array.isArray(profile.sections[section]) ? profile.sections[section] : []
    if (points.length === 0) continue
    const entries = points.map((p) => `  - ${String(p)}`).join('\n')
    lines.push(`[${section}]`, entries)
  }
  if (lines.length === 0) return undefined
  return [
    '<system-reminder>',
    'The following user profile is maintained globally across sessions. It summarizes stable facts about the user.',
    '',
    '<user_profile>',
    ...lines,
    '</user_profile>',
    '</system-reminder>',
  ].join('\n')
}

/* ------------------------------- migration ------------------------------ */

/** Migrate a v1 flat memories.json into the two-tier layout, once. */
async function migrateLegacyConfig(config) {
  const root = memoryRootOf(config)
  const legacyPath = join(root, 'memories.json')
  const raw = await readJson(legacyPath, null)
  if (!Array.isArray(raw)) return { migrated: false, reason: 'no-legacy-store' }

  const bySession = new Map()
  for (const item of raw) {
    if (!isRecord(item)) continue
    const sid = safeSessionId(item.sourceSession)
    if (!bySession.has(sid)) bySession.set(sid, [])
    bySession.get(sid).push(item)
  }

  const globalEntries = []
  for (const [sid, items] of bySession) {
    const memories = items
      .filter((i) => typeof i.content === 'string' && i.content.length > 0)
      .map((i) => ({
        id: typeof i.id === 'string' ? i.id : randomUUID(),
        content: i.content,
        category: typeof i.category === 'string' && i.category.length > 0 ? i.category : DEFAULT_CATEGORY,
        createdAt: Number(i.createdAt ?? Date.now()),
      }))
    if (memories.length === 0) continue
    const latest = Math.max(...memories.map((m) => m.createdAt))
    const firstContent = memories[0].content
    const keyPoints = normalizeKeyPoint(undefined, firstContent)
    const category = memories[0].category
    globalEntries.push({
      id: `g-${randomUUID()}`,
      sessionId: sid,
      title: `${Array.from(firstContent).slice(0, 12).join('')}…`,
      keyPoints,
      keywords: [],
      lastActivity: latest,
      category,
    })
    await writeSessionMemory(config, sid, {
      sessionId: sid,
      title: `${Array.from(firstContent).slice(0, 12).join('')}…`,
      summary: null,
      memories,
      updatedAt: latest,
    })
  }

  if (globalEntries.length > 0) {
    globalEntries.sort((a, b) => Number(b.lastActivity ?? 0) - Number(a.lastActivity ?? 0))
    await writeGlobal(config, globalEntries)
  }
  // Rename the legacy file so migration runs exactly once.
  await rename(legacyPath, `${legacyPath}.migrated-${Date.now()}`)
  return { migrated: true, sessions: bySession.size, memories: raw.length }
}

/* --------------------------------- tools -------------------------------- */

function setupTools(ctx, config) {
  const maxMemoriesPerSession = config.maxMemoriesPerSession ?? DEFAULT_MAX_MEMORIES_PER_SESSION
  const maxProfilePoints = config.maxProfilePoints ?? DEFAULT_MAX_PROFILE_POINTS

  const saveTool = defineTool({
    name: 'save_memory',
    description: "Save a long-term memory that should persist across future sessions. The CURRENT session keeps exactly ONE memory: this call REWRITES that single memory (appending the new facts after deduplication) rather than creating an additional entry, and a compact global entry is maintained for the session. Call it again in the same session whenever new durable facts appear — nothing is duplicated and nothing is lost. CALL THIS TOOL ONLY WHEN ONE OF THESE EVENTS HAS ACTUALLY OCCURRED, and pass the matching trigger: 'user-request' — the user explicitly asked to remember something (记住/记一下/记下来/存一下/别忘了); 'acceptance' — the user explicitly accepted a deliverable (可以了/没问题/已生效/通过); 'decision' — this session settled a trade-off that cannot be re-derived from the repository, the docs, or the conversation; 'correction' — the user corrected an existing memory. DO NOT CALL IT because you are considering whether something is worth remembering, for intermediate progress, for unfinished TODOs, for content already readable in the repository/docs/context, or for unverified guesses; an explicit user request outranks that exclusion list. For 'acceptance'/'decision'/'correction' ALSO pass evidence — a verbatim user quote, or a verifiable artifact (path, command, hash, number); if no evidence can be cited, do not save. Provide keyPoint: an ultra-compact one-line summary (default ≤ 50 characters, the shorter the better without ambiguity; may extend to 100 characters only when it must keep un-truncatable tokens like serial numbers, keys, or addresses intact). PROFILES: while saving, judge whether the memory also conveys stable user-profile information (identity, work role, personal context, technical stack, communication style). If so, ALSO pass profileUpdate (one concise profile point) and profileSection (identity | work | personal | technical | style) so the global user profile stays current. Delegated subagents have READ-ONLY memory access — the delegating agent owns the write. ${SAVE_MEMORY_CONTENT_RULE}",
    parameters: {
      content: { type: 'string', required: true, description: "The full memory content to remember, in the user's own terms." },
      trigger: { type: 'string', required: true, description: "Why this save is happening — the occurred event: 'user-request' | 'acceptance' | 'decision' | 'correction'. Required; any other value is rejected." },
      evidence: { type: 'string', description: "For acceptance/decision/correction: the anchor you actually checked — a verbatim user quote, or a verifiable artifact (file path, command, hash, number). Not required for user-request." },
      category: { type: 'string', description: 'Optional category label (e.g. preference, fact, project, style). Defaults to "general".' },
      keyPoint: { type: 'string', description: 'Ultra-compact global summary, ≤50 chars (≤100 only to keep critical tokens whole). If omitted, the plugin derives one from content.' },
      title: { type: 'string', description: 'Optional human-readable title for this session in the global index. If omitted, the existing title is kept or derived.' },
      profileUpdate: { type: 'string', description: 'Optional concise user-profile point to merge into the global profile (e.g. "the user runs the release tooling"). Omit when the memory has no stable profile value.' },
      profileSection: { type: 'string', description: "Profile section for profileUpdate: identity | work | personal | technical | style. Required if profileUpdate is provided." },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          stored: { type: 'boolean' },
          sessionId: { type: 'string' },
          trigger: { type: 'string' },
          reason: { type: 'string' },
          globalKeyPoint: { type: 'string' },
          total: { type: 'number' },
          profileUpdated: { type: 'boolean' },
          profileSection: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      // v2.3: delegated subagents are read-only (no save, no delete).
      assertMemoryWritable(config, exec.agent, 'save_memory')
      rememberRoute(exec.agent)
      const ownSessionId = exec.agent && exec.agent.id ? String(exec.agent.id) : null
      // A fork writes into its lineage's memory so updates never spawn a new entry.
      const sessionId = ownSessionId === null ? null : await resolveOwnerSessionId(config, exec.agent)
      const headerParent = exec.agent?.session?.header?.parentSession ?? null
      const store = memoryRootOf(config)
      const content = String(args.content ?? '').trim()
      if (!content) throw new Error('save_memory: content is required')

      // v2.4 gate 1: a closed list of events that have occurred. Merely
      // considering whether something is worth remembering is not one of them.
      const trigger = typeof args.trigger === 'string' ? args.trigger.trim() : ''
      if (!SAVE_TRIGGERS.includes(trigger)) {
        throw new Error(
          `save_memory: trigger is required and must be one of ${SAVE_TRIGGERS.join(' | ')}. `
          + 'Thinking about whether something is worth remembering is not a trigger: save only when the '
          + 'user asked to remember, the user accepted a deliverable, a trade-off was settled, or an '
          + 'existing memory was corrected.',
        )
      }
      // v2.4 gate 2: auto-saves must cite an anchor that was actually checked.
      const evidence = typeof args.evidence === 'string' ? args.evidence.trim() : ''
      const requireEvidence = config.saveRequireEvidence ?? DEFAULT_SAVE_REQUIRE_EVIDENCE
      if (requireEvidence && EVIDENCE_REQUIRED_TRIGGERS.includes(trigger) && evidence.length === 0) {
        throw new Error(
          `save_memory: trigger="${trigger}" requires evidence — a verbatim user quote, or a verifiable `
          + 'artifact (path, command, hash, number). If no evidence can be cited, do not save.',
        )
      }

      // Session tier: append the full memory to this session's file.
      let doc
      if (sessionId !== null) {
        doc = (await readSessionMemory(config, sessionId)) ?? {
          sessionId,
          title: null,
          summary: null,
          memories: [],
          updatedAt: null,
        }
        // Record this session's own lineage so descendants can walk up to us.
        doc.origin = {
          ...(isRecord(doc.origin) ? doc.origin : {}),
          ...(typeof headerParent === 'string' && headerParent.length > 0 ? { parentSession: headerParent } : {}),
          lastWriter: ownSessionId,
        }
        // v2.16: ONE memory per session — a save rewrites that single memory
        // (deduplicated append) instead of appending a new list item. v2.4 gate 3
        // (idempotent writes) lives inside the same rule: an already-covered fact
        // is reported as a no-op rather than accumulated again.
        const saveCategory = typeof args.category === 'string' && args.category.length > 0 ? args.category : DEFAULT_CATEGORY
        const outcome = mergeIntoSessionMemory(doc, content, saveCategory)
        if (outcome.created === false && outcome.merged === false) {
          return { stored: false, sessionId, trigger, reason: outcome.reason, total: doc.memories.length }
        }
        if (typeof args.title === 'string' && args.title.trim().length > 0) doc.title = args.title.trim()
        await writeSessionMemory(config, sessionId, doc)
      }

      // Global tier: derive/refresh the compact entry for this session.
      const keyPoint = normalizeKeyPoint(args.keyPoint, content)
      const category = typeof args.category === 'string' && args.category.length > 0 ? args.category : DEFAULT_CATEGORY
      // Serialized per root: concurrent saves must not lose each other's entry.
      const entry = await withGlobalLock(config, async () => {
        const globalEntries = await readGlobal(config)
        let current = globalEntries.find((e) => e.sessionId === sessionId)
        if (current === undefined) {
          current = {
            id: `g-${randomUUID()}`,
            sessionId,
            title: typeof args.title === 'string' && args.title.trim().length > 0
              ? args.title.trim()
              : (doc && doc.title) || `${Array.from(content).slice(0, 12).join('')}…`,
            keyPoints: keyPoint,
            keywords: [],
            lastActivity: Date.now(),
            category,
          }
          globalEntries.push(current)
        } else {
          if (keyPoint) current.keyPoints = keyPoint
          if (typeof args.title === 'string' && args.title.trim().length > 0) current.title = args.title.trim()
          current.category = category
          current.lastActivity = Date.now()
        }
        globalEntries.sort((a, b) => Number(b.lastActivity ?? 0) - Number(a.lastActivity ?? 0))
        await writeGlobal(config, globalEntries)
        return current
      })

      // Profile tier: merge a profile-worthy point if the model judged one.
      let profileUpdated = false
      let profileSection = null
      if (typeof args.profileUpdate === 'string' && args.profileUpdate.trim().length > 0) {
        const merged = await mergeProfilePoint(config, args.profileSection, args.profileUpdate)
        if (merged !== null) {
          profileUpdated = true
          profileSection = merged
        }
      }

      // Search index (v2.2): keep the derived FTS5 index in sync.
      if (doc && doc.memories.length > 0) {
        const record = doc.memories.at(-1)
        await indexUpsert(config, {
          sessionId,
          memoryId: record.id,
          category: record.category,
          content: record.content,
          createdAt: record.createdAt,
        })
      }

      // Auto backup (v2.2): at most once per interval.
      await maybeBackup(config)

      return {
        ...(doc !== undefined && doc.memories.length > 0 ? { id: doc.memories.at(-1).id } : {}),
        stored: true,
        ...(sessionId !== null ? { sessionId } : {}),
        trigger,
        globalKeyPoint: entry.keyPoints,
        total: doc ? doc.memories.length : 0,
        profileUpdated,
        ...(profileSection !== null ? { profileSection } : {}),
      }
    },
    presentCall() {
      return { card: 'generic', title: 'Save memory', kind: 'write' }
    },
  })

  const recallTool = defineTool({
    name: 'recall_memory',
    description: "List or search saved long-term memories. scope 'profile' returns the global user profile only; scope 'global' returns the compact per-session index only; scope 'session' returns full session memories (optionally one session via sessionId); scope 'all' (default) merges profile + global + session. Note: full session memories (including the CURRENT session's) are NOT auto-injected into context — call this with a query whenever you need a detail recorded by save_memory, for this session or a past one. Optional query substring and category filters apply.",
    parameters: {
      query: { type: 'string', description: 'Optional substring to filter memory content by.' },
      category: { type: 'string', description: 'Optional exact category to filter by.' },
      scope: { type: 'string', description: "Filter scope: 'profile' | 'global' | 'session' | 'all' (default 'all')." },
      sessionId: { type: 'string', description: 'Optional session id; for scope=session returns only that session\'s full memories.' },
      limit: { type: 'number', description: 'Optional result limit (default 50).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          profile: {
            type: 'object',
            additionalProperties: false,
            properties: {
              updatedAt: { type: 'number' },
              sections: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  identity: { type: 'array', items: { type: 'string' } },
                  work: { type: 'array', items: { type: 'string' } },
                  personal: { type: 'array', items: { type: 'string' } },
                  technical: { type: 'array', items: { type: 'string' } },
                  style: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
          global: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                title: { type: 'string' },
                keyPoints: { type: 'string' },
                category: { type: 'string' },
                lastActivity: { type: 'number' },
              },
            },
          },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                title: { type: 'string' },
                memories: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string' },
                      content: { type: 'string' },
                      category: { type: 'string' },
                      createdAt: { type: 'number' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const scope = typeof args.scope === 'string' ? args.scope : 'all'
      const query = typeof args.query === 'string' && args.query.length > 0 ? args.query.toLowerCase() : ''
      const category = typeof args.category === 'string' && args.category.length > 0 ? args.category.toLowerCase() : ''
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : DEFAULT_RECALL_LIMIT
      const wantProfile = scope === 'profile' || scope === 'all'
      const wantGlobal = scope === 'global' || scope === 'all'
      const wantSessions = scope === 'session' || scope === 'all'

      let profileRow
      if (wantProfile) {
        const profile = await readProfile(config)
        const sections = {}
        for (const section of PROFILE_SECTIONS) {
          sections[section] = (Array.isArray(profile.sections[section]) ? profile.sections[section] : [])
            .map((p) => String(p))
            .slice(0, limit)
        }
        profileRow = { updatedAt: Number(profile.updatedAt ?? 0), sections }
      }

      const globalRows = []
      if (wantGlobal) {
        const entries = await readGlobal(config)
        for (const e of entries) {
          if (category && String(e.category || '').toLowerCase() !== category) continue
          if (query && !(
            String(e.title || '').toLowerCase().includes(query)
            || String(e.keyPoints || '').toLowerCase().includes(query)
          )) continue
          globalRows.push({
            sessionId: String(e.sessionId ?? ''),
            title: String(e.title ?? ''),
            keyPoints: String(e.keyPoints ?? ''),
            category: String(e.category ?? ''),
            lastActivity: Number(e.lastActivity ?? 0),
          })
        }
      }

      const sessionRows = []
      if (wantSessions) {
        if (query) {
          // v2.2: prefer the FTS5 index (LIKE fallback inside for short/missed
          // queries). When the index itself is unavailable (hits === null),
          // fall back to the v2 substring scan so recall never goes empty
          // merely because SQLite is missing.
          const hits = await indexSearch(config, query, { limit, category: category || undefined })
          const indexAvailable = hits !== null
          if (indexAvailable && hits.length > 0) {
            const bySession = new Map()
            for (const h of hits) {
              const sid = String(h.sessionId ?? '')
              if (!bySession.has(sid)) bySession.set(sid, [])
              bySession.get(sid).push({
                id: String(h.memoryId),
                content: String(h.content),
                category: String(h.category ?? ''),
                createdAt: Number(h.createdAt ?? 0),
              })
            }
            for (const [sid, memories] of bySession) {
              const doc = await readSessionMemory(config, sid)
              sessionRows.push({
                sessionId: sid,
                title: doc && typeof doc.title === 'string' ? doc.title : '',
                memories,
              })
            }
          } else if (!indexAvailable) {
            const wanted = typeof args.sessionId === 'string' && args.sessionId.length > 0
              ? [args.sessionId]
              : await listSessionFiles(config)
            for (const sid of wanted) {
              const doc = await readSessionMemory(config, sid)
              if (!doc) continue
              const memories = doc.memories
                .filter((m) => {
                  if (category && String(m.category || '').toLowerCase() !== category) return false
                  if (query && !String(m.content || '').toLowerCase().includes(query)) return false
                  return true
                })
                .map((m) => ({
                  id: String(m.id),
                  content: String(m.content),
                  category: String(m.category ?? ''),
                  createdAt: Number(m.createdAt ?? 0),
                }))
              if (memories.length > 0) {
                sessionRows.push({
                  sessionId: sid,
                  title: typeof doc.title === 'string' ? doc.title : '',
                  memories,
                })
              }
            }
          }
        } else {
          const wanted = typeof args.sessionId === 'string' && args.sessionId.length > 0
            ? [args.sessionId]
            : await listSessionFiles(config)
          for (const sid of wanted) {
            const doc = await readSessionMemory(config, sid)
            if (!doc) continue
            const filters = (m) => {
              if (category && String(m.category || '').toLowerCase() !== category) return false
              return true
            }
            const memories = doc.memories.filter(filters).map((m) => ({
              id: String(m.id),
              content: String(m.content),
              category: String(m.category ?? ''),
              createdAt: Number(m.createdAt ?? 0),
            }))
            if (memories.length > 0) {
              sessionRows.push({
                sessionId: sid,
                title: typeof doc.title === 'string' ? doc.title : '',
                memories,
              })
            }
          }
        }
      }

      return {
        ...(profileRow !== undefined ? { profile: profileRow } : {}),
        global: globalRows.slice(0, limit),
        sessions: sessionRows.slice(0, limit),
      }
    },
    presentCall() {
      return { card: 'generic', title: 'Recall memories', kind: 'read' }
    },
  })

  const loadSessionTool = defineTool({
    name: 'load_session_memory',
    description: "Load a PAST session's FULL memory into the current conversation (on demand). Call this when the current topic relates to a session listed in the global memory index. The loaded memory is injected as context for subsequent steps.",
    parameters: {
      sessionId: { type: 'string', required: true, description: 'The sessionId from a global memory index entry (or recall_memory).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          loaded: { type: 'boolean' },
          sessionId: { type: 'string' },
          title: { type: 'string' },
          count: { type: 'number' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const sid = safeSessionId(args.sessionId)
      const doc = await readSessionMemory(config, sid)
      if (!doc || !Array.isArray(doc.memories) || doc.memories.length === 0) {
        return { loaded: false, sessionId: args.sessionId, count: 0, reason: 'no-memories-found' }
      }
      const text = renderSessionMemory(doc, args.sessionId)
      if (text !== undefined && typeof exec.deferContext === 'function') {
        exec.deferContext(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin:dsh-memory', form: 'recall' },
        }))
      }
      return {
        loaded: true,
        sessionId: args.sessionId,
        title: typeof doc.title === 'string' ? doc.title : '',
        count: doc.memories.length,
      }
    },
    presentCall() {
      return { card: 'generic', title: 'Load session memory', kind: 'read' }
    },
  })

  const forgetTool = defineTool({
    name: 'forget_memory',
    description: 'Delete a saved memory. Pass id to remove one full-memory entry (its session global entry is refreshed/removed if emptied), or sessionId to delete an entire session (file + global entry). Returns what was removed. Delegated subagents have READ-ONLY memory access.',
    parameters: {
      id: { type: 'string', description: 'The id of one full-memory entry to forget.' },
      sessionId: { type: 'string', description: 'The sessionId of an entire session to forget.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'boolean' },
          removedSession: { type: 'boolean' },
          total: { type: 'number' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      // v2.3: delegated subagents are read-only (no save, no delete).
      assertMemoryWritable(config, exec.agent, 'forget_memory')
      if (typeof args.sessionId === 'string' && args.sessionId.length > 0) {
        const sid = safeSessionId(args.sessionId)
        const p = sessionPathOf(memoryRootOf(config), sid)
        let existed = true
        try {
          await readJson(p, null)
        } catch {
          existed = false
        }
        // Remove the file, then drop the global entry.
        try {
          await rename(p, `${p}.deleted-${Date.now()}`)
        } catch {
          existed = false
        }
        const remaining = await withGlobalLock(config, async () => {
          const globalEntries = await readGlobal(config)
          const next = globalEntries.filter((e) => e.sessionId !== sid)
          if (next.length !== globalEntries.length) await writeGlobal(config, next)
          return next
        })
        await indexRemove(config, { sessionId: sid })
        return { removed: existed, removedSession: existed, total: remaining.length }
      }

      if (typeof args.id === 'string' && args.id.length > 0) {
        const sessionIds = await listSessionFiles(config)
        for (const sid of sessionIds) {
          const doc = await readSessionMemory(config, sid)
          if (!doc || !Array.isArray(doc.memories)) continue
          const before = doc.memories.length
          doc.memories = doc.memories.filter((m) => m.id !== args.id)
          if (doc.memories.length === before) continue
          await writeSessionMemory(config, sid, doc)
          await indexRemove(config, { memoryId: args.id })
          // Sync the global entry: if the session became empty, drop it.
          await withGlobalLock(config, async () => {
            const globalEntries = await readGlobal(config)
            if (doc.memories.length === 0) {
              const remaining = globalEntries.filter((e) => e.sessionId !== sid)
              if (remaining.length !== globalEntries.length) await writeGlobal(config, remaining)
            } else {
              const entry = globalEntries.find((e) => e.sessionId === sid)
              if (entry) {
                entry.lastActivity = Date.now()
                await writeGlobal(config, globalEntries)
              }
            }
          })
          return { removed: true, removedSession: doc.memories.length === 0, total: doc.memories.length }
        }
        return { removed: false, removedSession: false, total: 0 }
      }

      return { removed: false, removedSession: false, total: 0 }
    },
    presentCall() {
      return { card: 'generic', title: 'Forget memory', kind: 'write' }
    },
  })

  ctx.tools.register(saveTool)
  ctx.tools.register(recallTool)
  ctx.tools.register(loadSessionTool)
  ctx.tools.register(forgetTool)
}

/* -------------------------------- injection ------------------------------ */

/**
 * Inject the memory context (user profile + compact global index) as DSH
 * runtime context — the same strategy as the system prompt and tools.
 *
 * A registered context provider is evaluated at EVERY assembly, and DSH's
 * RuntimeContextProjection materializes a snapshot ONLY when the rendered
 * text differs from the retained one. Unchanged steps therefore inject
 * nothing: no per-step duplication, no context growth. A save in ANOTHER
 * session changes global.json, so the next step renders differently and one
 * update snapshot is emitted — cross-session freshness with neither a restart
 * nor a re-opened session.
 *
 * `PromptContext.text` is synchronous, so rendering goes through an mtime+size
 * stamp: untouched files reuse the cached string (no parse, no render), while
 * any writer — this session, another session, a hand edit — changes the stamp.
 *
 * Current-session full memory is NOT injected (its own message history is
 * already in context); it is fetched on demand via recall_memory /
 * load_session_memory.
 *
 * Fallback: when the systemPrompt service cannot register context, a pre-step
 * hook appends the same text, but ONLY when it changed since the last append.
 */
function setupInjection(ctx, config) {
  const injectLimit = configNumber(config.injectLimit, DEFAULT_INJECT_LIMIT)
  const maxInjectBytes = configNumber(config.maxInjectBytes, DEFAULT_MAX_INJECT_BYTES)

  // mtime+size-guarded render cache shared by both delivery paths.
  const cache = { stamp: null, text: '' }
  const renderCached = () => {
    const stamp = freshnessStamp(config)
    if (cache.stamp === stamp) return cache.text
    const text = composeInjection(
      readProfileSync(config),
      readGlobalSync(config),
      injectLimit,
      maxInjectBytes,
    )
    cache.stamp = stamp
    cache.text = text
    return text
  }

  const systemPrompt = ctx.systemPrompt
  if (systemPrompt !== undefined && typeof systemPrompt.context === 'function') {
    systemPrompt.context({
      name: 'dsh-memory',
      order: MEMORY_CONTEXT_ORDER,
      text: () => {
        try {
          return renderCached()
        } catch {
          // Never break prompt assembly; keep the last good snapshot.
          return cache.text
        }
      },
    })
    return
  }

  // Fallback delivery: append only when the rendered text actually changed.
  let lastInjected = null
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal?.throwIfAborted()

    const ownTool = ctx.tools.get('save_memory', agent)
    if (ownTool === undefined) return decision

    const profile = await readProfile(config)
    signal?.throwIfAborted()
    const globalEntries = await readGlobal(config)
    signal?.throwIfAborted()
    const text = composeInjection(profile, globalEntries, injectLimit, maxInjectBytes)
    if (text.length === 0 || text === lastInjected) return decision
    lastInjected = text

    const injected = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin:dsh-memory', form: 'recall' },
    })
    return { ...decision, messages: [...decision.messages, injected] }
  })
}

/* --------------------- config page bridge (v2.5) ------------------------ */
/*
 * The Plugins page renders dsh-memory's row config from client.js; that page
 * reads and writes the store through these loopback-only routes. Edits are the
 * same bytes the model writes — JSON is the source of truth — so a hand edit and
 * a save_memory call cannot disagree. Mutations share the per-root lock with
 * save_memory/forget_memory, and the injected snapshot refreshes on its own
 * because the render cache is keyed by the files' mtime+size.
 */

const STORE_BRIDGE_PATH = '/api/dsh-memory-store'
const BRIDGE_BODY_MAX_BYTES = 1024 * 1024
const BRIDGE_POINT_MAX_CHARS = 4000
const BRIDGE_TITLE_MAX_CHARS = 200
const BRIDGE_CATEGORY_MAX_CHARS = 40
/** Runtime-tunable config the page may write back through the settings service. */
const BRIDGE_CONFIG_FIELDS = ['injectLimit', 'maxInjectBytes']
/** User-chosen consolidation model fields (strings) the page may save. */
const BRIDGE_CONFIG_STRING_FIELDS = ['consolidationProvider', 'consolidationModel', 'consolidationReasoningEffort']

/*
 * Injection accounting. Both formulas price the RENDERED text — exactly what the
 * model receives — and both are reported because they disagree on Chinese by
 * design:
 *  - tokens: CJK-aware estimate (a CJK char costs ~0.7 token; 4 other chars ~1).
 *  - dshTokens: DSH's own fixed-density heuristic (text.length / 4, see
 *    packages/llm/token-meter/src/estimate.ts), which is what the harness's
 *    context accounting uses. Kept so the numbers stay comparable with the GUI,
 *    knowing that it systematically underprices CJK.
 */
/**
 * Read a numeric config field. A `.volatile()` field resolves to a live
 * cosmokit cell (frozen `{ get, [write] }`), not to the value itself, so every
 * read goes through `.get()`; plain fields pass through unchanged.
 */
function configNumber(raw, fallback) {
  const value = raw !== null && typeof raw === 'object' && typeof raw.get === 'function' ? raw.get() : raw
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback
}

/** Read a string config field, unwrapping the `.volatile()` cell like configNumber. */
function configString(raw, fallback) {
  const value = raw !== null && typeof raw === 'object' && typeof raw.get === 'function' ? raw.get() : raw
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

const CJK_TOKENS_PER_CHAR = 0.7
const NON_CJK_CHARS_PER_TOKEN = 4
const CJK_PATTERN = /[\u2e80-\u303f\u3040-\u33ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/u

function estimateInjectionTokens(text) {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (CJK_PATTERN.test(char)) cjk++
    else other++
  }
  return Math.ceil(cjk * CJK_TOKENS_PER_CHAR + other / NON_CJK_CHARS_PER_TOKEN)
}

function blockMetrics(text) {
  const value = typeof text === 'string' ? text : ''
  return {
    chars: [...value].length,
    bytes: Buffer.byteLength(value, 'utf8'),
    tokens: estimateInjectionTokens(value),
    dshTokens: Math.ceil(value.length / 4),
  }
}

/**
 * Price the current injection: one block per tier plus the effective total
 * `composeInjection` produces under the byte budget.
 * @param override - pending or preview `{ injectLimit, maxInjectBytes }`.
 */
function injectionMetrics(config, profile, entries, override = {}) {
  const injectLimit = Math.max(1, configNumber(override.injectLimit, configNumber(config.injectLimit, DEFAULT_INJECT_LIMIT)))
  const maxInjectBytes = Math.max(
    1,
    configNumber(override.maxInjectBytes, configNumber(config.maxInjectBytes, DEFAULT_MAX_INJECT_BYTES)),
  )
  const richest = composeInjection(profile, entries, entries.length, Number.MAX_SAFE_INTEGER)
  const picked = pickInjection(profile, entries, injectLimit, maxInjectBytes)
  const total = blockMetrics(picked.text)
  const indexBlock = blockMetrics(picked.indexPart)
  const profileBlock = blockMetrics(picked.profilePart)
  const keyPointEntries = Number.isFinite(injectLimit) ? Math.min(entries.length, Math.max(0, Math.floor(injectLimit))) : entries.length
  return {
    injectLimit,
    maxInjectBytes,
    profile: profileBlock,
    // Every entry is listed now; `injectLimit` only decides how many carry key points.
    index: { ...indexBlock, entriesShown: entries.length, entriesTotal: entries.length, keyPointEntries },
    total: { ...total, budgetShare: maxInjectBytes > 0 ? total.bytes / maxInjectBytes : 0 },
    // `trimmed` means the byte budget bit: key points were clipped, entries fell
    // back to titles only, or the profile was cut back to its first and last lines.
    trimmed: picked.text !== richest,
  }
}

function isLoopbackRequest(req) {
  const address = req?.socket?.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sendBridgeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

async function readBridgeBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BRIDGE_BODY_MAX_BYTES) return undefined
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * Create or refresh the single index entry that owns one session's memories.
 * The link is `entry.sessionId <-> sessions/<sessionId>.json`, so this is the
 * only writer that may create an entry outside save_memory.
 */
async function upsertSessionEntryLocked(config, sessionId, { keyPoint, title, category, lastActivity }) {
  {
    const entries = await readGlobal(config)
    let current = entries.find((entry) => entry.sessionId === sessionId)
    if (current === undefined) {
      current = {
        id: `g-${randomUUID()}`,
        sessionId,
        title: typeof title === 'string' && title.trim().length > 0 ? title.trim() : sessionId,
        keyPoints: '',
        keywords: [],
        lastActivity: Number.isFinite(lastActivity) ? lastActivity : Date.now(),
        category: typeof category === 'string' && category.length > 0 ? category : DEFAULT_CATEGORY,
      }
      entries.push(current)
    }
    if (typeof keyPoint === 'string' && keyPoint.length > 0) current.keyPoints = normalizeKeyPoint(keyPoint, keyPoint)
    if (typeof title === 'string' && title.trim().length > 0) current.title = title.trim()
    if (typeof category === 'string' && category.length > 0) current.category = category
    current.lastActivity = Number.isFinite(lastActivity) ? lastActivity : Date.now()
    entries.sort((a, b) => Number(b.lastActivity ?? 0) - Number(a.lastActivity ?? 0))
    await writeGlobal(config, entries)
    return current
  }
}

/**
 * Locking wrapper. `withGlobalLock` is a promise chain, not reentrant, so callers
 * that already hold the lock (session consolidation apply, doctor.repair) must use
 * `upsertSessionEntryLocked` instead or they would wait on themselves.
 */
function upsertSessionEntry(config, sessionId, fields) {
  return withGlobalLock(config, () => upsertSessionEntryLocked(config, sessionId, fields))
}

/**
 * Fold a session's memories into exactly one entry without an LLM: dedupe exact
 * repeats and join the rest. Used by the save path, by doctor.repair, and by the
 * editor button, so the one-memory-per-session rule never needs a model call.
 */
/**
 * Apply one save to a session document under the one-memory-per-session rule:
 * a legacy multi-memory file is folded first, then the new text is appended to
 * the single memory after deduplication. Returns the outcome instead of throwing
 * for the no-op case, so the tool can report it verbatim.
 */
export function mergeIntoSessionMemory(doc, content, category) {
  if (doc.memories.length > 1) collapseSessionMemories(doc)
  const fingerprint = normalizeMemoryText(content)
  const single = doc.memories[0]
  if (single === undefined) {
    const record = { id: randomUUID(), content, category, createdAt: Date.now(), mergedCount: 1 }
    doc.memories.push(record)
    doc.updatedAt = record.createdAt
    return { doc, id: record.id, merged: false, created: true }
  }
  if (normalizeMemoryText(single.content).includes(fingerprint)) {
    return { doc, id: single.id, merged: false, created: false, reason: `already contained in this session's single memory ${single.id} — nothing written` }
  }
  const merged = `${single.content}\n${content}`.trim()
  if (Array.from(merged).length > SESSION_MEMORY_MAX_CHARS) {
    return {
      doc,
      id: single.id,
      merged: false,
      created: false,
      overflow: Array.from(merged).length,
      reason: `this session's single memory would reach ${Array.from(merged).length} characters (cap ${SESSION_MEMORY_MAX_CHARS}); compress it first (插件页 → 会话记忆 → 整理该会话) and save again`,
    }
  }
  single.content = merged
  single.category = category
  single.updatedAt = Date.now()
  single.mergedCount = Number(single.mergedCount ?? 1) + 1
  doc.updatedAt = single.updatedAt
  return { doc, id: single.id, merged: true, created: false }
}

function collapseSessionMemories(doc) {
  const source = Array.isArray(doc.memories) ? doc.memories : []
  const parts = []
  for (const memory of source) {
    const text = String(memory.content ?? '').trim()
    if (text.length === 0) continue
    const fingerprint = normalizeMemoryText(text)
    if (parts.some((part) => normalizeMemoryText(part).includes(fingerprint))) continue
    parts.push(text)
  }
  if (parts.length === 0) {
    doc.memories = []
    return doc
  }
  const newest = source.reduce((best, memory) => (Number(memory.createdAt ?? 0) >= Number(best.createdAt ?? 0) ? memory : best), source[0])
  doc.memories = [{
    ...source[0],
    content: parts.join('\n'),
    category: newest.category ?? source[0].category ?? DEFAULT_CATEGORY,
    updatedAt: Date.now(),
    mergedCount: source.length,
  }]
  return doc
}

/** Audit the session-file <-> index-entry link in both directions. */
async function auditMemoryLinks(config) {
  const sessions = await listSessionSummaries(config)
  const entries = await readGlobal(config)
  const bySession = new Map()
  for (const entry of entries) {
    const sid = entry.sessionId
    if (typeof sid !== 'string' || sid.length === 0) continue
    bySession.set(sid, [...(bySession.get(sid) ?? []), entry])
  }
  const sessionIds = new Set(sessions.map((row) => row.sessionId))
  return {
    ok: true,
    counts: { sessions: sessions.length, entries: entries.length },
    missingEntries: sessions.filter((row) => !bySession.has(row.sessionId)).map((row) => ({ sessionId: row.sessionId, count: row.count, title: row.title })),
    orphanEntries: entries
      .filter((entry) => typeof entry.sessionId !== 'string' || entry.sessionId.length === 0 || !sessionIds.has(entry.sessionId))
      .map((entry) => ({ id: entry.id, sessionId: entry.sessionId ?? null, title: entry.title ?? '' })),
    emptySessions: sessions.filter((row) => row.count === 0).map((row) => row.sessionId),
    multiMemorySessions: sessions.filter((row) => row.count > 1).map((row) => ({ sessionId: row.sessionId, count: row.count })),
    // Informational only: a dangling memory has no DSH conversation on this
    // machine, which is normal for imported memories and is NOT an anomaly.
    sessionLinks: sessionLinkScan ?? { at: null, dshSessions: 0, memories: sessions.length, linked: [], dangling: [] },
    duplicateEntries: [...bySession.entries()].filter(([, list]) => list.length > 1).map(([sessionId, list]) => ({ sessionId, ids: list.map((entry) => entry.id) })),
  }
}

/** Repair the audited link problems; returns what was changed. */
async function repairMemoryLinks(config) {
  const audit = await auditMemoryLinks(config)
  const actions = []
  for (const row of audit.missingEntries) {
    const doc = await readSessionMemory(config, row.sessionId)
    if (doc === null) continue
    const memories = Array.isArray(doc.memories) ? doc.memories : []
    if (memories.length === 0) continue
    const first = memories[0]
    const newest = memories.reduce((best, memory) => (Number(memory.createdAt ?? 0) >= Number(best.createdAt ?? 0) ? memory : best), first)
    await upsertSessionEntryLocked(config, row.sessionId, {
      keyPoint: normalizeKeyPoint(undefined, first.content),
      title: typeof doc.title === 'string' && doc.title.trim().length > 0 ? doc.title : undefined,
      category: first.category,
      lastActivity: Number.isFinite(doc.updatedAt) ? doc.updatedAt : Number(newest.createdAt ?? Date.now()),
    })
    actions.push(`补建条目：${row.sessionId}（${memories.length} 条记忆）`)
  }
  for (const row of audit.orphanEntries) {
    const entries = await readGlobal(config)
    const next = entries.filter((entry) => entry.id !== row.id)
    if (next.length !== entries.length) {
      await writeGlobal(config, next)
      actions.push(`删除孤儿条目：${row.id}${row.sessionId === null ? '' : `（会话 ${row.sessionId} 已不存在）`}`)
    }
  }
  for (const dup of audit.duplicateEntries) {
    const entries = await readGlobal(config)
    const ranked = entries
      .filter((entry) => entry.sessionId === dup.sessionId)
      .sort((a, b) => Number(b.lastActivity ?? 0) - Number(a.lastActivity ?? 0))
    const drop = new Set(ranked.slice(1).map((entry) => entry.id))
    if (drop.size > 0) {
      await writeGlobal(config, entries.filter((entry) => !drop.has(entry.id)))
      actions.push(`删除重复条目：${dup.sessionId}（保留最新一条）`)
    }
  }
  for (const row of audit.multiMemorySessions ?? []) {
    const doc = await readSessionMemory(config, row.sessionId)
    if (doc === null || doc.memories.length <= 1) continue
    collapseSessionMemories(doc)
    doc.updatedAt = Date.now()
    await writeSessionMemory(config, row.sessionId, doc)
    await indexRemove(config, { sessionId: row.sessionId })
    for (const memory of doc.memories) {
      await indexUpsert(config, {
        sessionId: row.sessionId,
        memoryId: memory.id,
        category: memory.category,
        content: memory.content,
        createdAt: memory.createdAt,
      })
    }
    actions.push(`折叠为一条：${row.sessionId}（${row.count} → 1 条）`)
  }

  for (const sessionId of audit.emptySessions) {
    const file = sessionPathOf(memoryRootOf(config), sessionId)
    try {
      await rm(file, { force: true })
    } catch {
      /* ignore */
    }
    const entries = await readGlobal(config)
    const next = entries.filter((entry) => entry.sessionId !== sessionId)
    if (next.length !== entries.length) await writeGlobal(config, next)
    await indexRemove(config, { sessionId })
    actions.push(`清理空会话：${sessionId}`)
  }
  return { ok: true, actions, before: audit }
}

/**
 * Resolve which session's memory file this agent's saves belong to.
 *
 * A forked session inherits the transcript prefix of its parent (DSH exposes
 * `header.parentSession`), so it is the *same conversation*: attributing its
 * saves to the lineage's topmost known session keeps one memory per conversation
 * instead of a fresh entry per fork. The chain is walked through each ancestor's
 * recorded `origin.parentSession`, and stops at the first ancestor without a
 * record — that ancestor still becomes the owner, so siblings converge.
 */
export async function resolveOwnerSessionId(config, agent) {
  const own = agent !== undefined && agent !== null && agent.id !== undefined && agent.id !== null ? String(agent.id) : null
  if (own === null) return null
  if ((config.inheritForkMemory ?? DEFAULT_INHERIT_FORK_MEMORY) !== true) return own
  const headerParent = agent?.session?.header?.parentSession
  if (typeof headerParent !== 'string' || headerParent.length === 0) return own
  const seen = new Set([own])
  let owner = headerParent
  for (let depth = 0; depth < 16; depth++) {
    if (seen.has(owner)) break
    seen.add(owner)
    const doc = await readSessionMemory(config, owner)
    const up = doc?.origin?.parentSession
    if (typeof up !== 'string' || up.length === 0) break
    owner = up
  }
  return owner
}

/** Every session id DSH has a log directory for, on this machine. */
async function listDshSessionIds(config) {
  const ids = new Set()
  const root = join(dirname(memoryRootOf(config)), 'sessions')
  let slugs = []
  try {
    slugs = await readdir(root)
  } catch {
    return ids
  }
  for (const slug of slugs) {
    let entries = []
    try {
      entries = await readdir(join(root, slug))
    } catch {
      continue
    }
    for (const name of entries) if (name.startsWith('session-')) ids.add(name)
  }
  return ids
}

/**
 * Link scan: a memory is "linked" when DSH still has the conversation it came
 * from, and "dangling" when it does not (imported from another machine, or the
 * log was pruned). Dangling is a normal state — the memory stays fully readable
 * and injected; the scan only feeds the editor, the report, and the doctor view
 * (which must never treat dangling as an anomaly: there is no plugin file missing).
 */
export async function scanSessionLinks(config) {
  const memoryIds = await listSessionFiles(config)
  const dshIds = await listDshSessionIds(config)
  const linked = []
  const dangling = []
  for (const id of memoryIds) (dshIds.has(id) ? linked : dangling).push(id)
  sessionLinkScan = {
    at: Date.now(),
    dshSessions: dshIds.size,
    memories: memoryIds.length,
    linked,
    dangling,
  }
  return sessionLinkScan
}

/** Compact per-session rows for the editor's session list. */
/** Collect the export material for the requested scope. */
async function collectExportScope(config, options) {
  const entries = await readGlobal(config)
  let ids = await listSessionFiles(config)
  if (Array.isArray(options.sessionIds) && options.sessionIds.length > 0) {
    const wanted = new Set(options.sessionIds.map((id) => safeSessionId(id)))
    ids = ids.filter((id) => wanted.has(id))
  }
  const sessions = []
  for (const id of ids) {
    const doc = await readSessionMemory(config, id)
    if (doc === null) continue
    const memories = Array.isArray(doc.memories) ? doc.memories : []
    if (memories.length === 0) continue
    if (typeof options.category === 'string' && options.category.length > 0
      && !memories.some((memory) => (memory.category ?? DEFAULT_CATEGORY) === options.category)) continue
    if (Number.isFinite(options.since) && Number(doc.updatedAt ?? 0) < options.since) continue
    if (typeof options.query === 'string' && options.query.trim().length > 0) {
      const needle = options.query.trim().toLowerCase()
      if (!memories.some((memory) => String(memory.content ?? '').toLowerCase().includes(needle))) continue
    }
    sessions.push({ sessionId: id, title: doc.title ?? null, origin: doc.origin ?? null, memories })
  }
  // Hard rule: entries are derived from the selected sessions, never chosen alone.
  const selected = new Set(sessions.map((session) => session.sessionId))
  return {
    profile: options.profile === false ? null : await readProfile(config),
    entries: entries.filter((entry) => selected.has(entry.sessionId)),
    sessions,
  }
}

/** Files sitting in the transfer directory (the only path import will read). */
async function listTransferFiles(config) {
  const dir = transferDirOf(config)
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const rows = []
  for (const fileName of names.filter((entry) => entry.endsWith('.json')).sort()) {
    try {
      const info = await stat(join(dir, fileName))
      rows.push({ file: fileName, size: info.size, mtime: info.mtimeMs })
    } catch {
      continue
    }
  }
  return rows
}

/** Import snapshots (and any other manifest-bearing backup) for the page. */
async function listBackupSnapshots(config, limit = 20) {
  const dir = join(memoryRootOf(config), 'memory-backup')
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const rows = []
  for (const name of names.sort().reverse()) {
    const manifestPath = join(dir, name, 'manifest.json')
    let manifest = null
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch {
      manifest = null
    }
    const files = Array.isArray(manifest?.files) ? manifest.files : []
    rows.push({
      snapshot: name,
      kind: manifest?.kind ?? null,
      at: Number.isFinite(manifest?.at) ? manifest.at : null,
      files: files.length,
      sessions: files.filter((file) => String(file.relPath).startsWith('sessions/')).length,
      created: files.filter((file) => file.state === 'absent').length,
      rollbackable: manifest !== null,
    })
    if (rows.length >= limit) break
  }
  return rows
}

/** Read one transfer file, enforcing the name shape and the size ceiling. */
async function readTransferFile(config, fileName) {
  const raw = String(fileName ?? '').trim()
  // A bare name resolves inside the transfer directory; an absolute path must
  // still be confined to the allowed roots.
  const path = raw.includes('/') || raw.startsWith('~')
    ? confinePath(config, raw)
    : join(transferDirOf(config), raw.replace(/[^A-Za-z0-9._-]/g, ''))
  if (!path.endsWith('.json')) throw new Error('only .json bundles can be imported')
  const info = await stat(path)
  if (info.size > TRANSFER_MAX_BYTES) throw new Error(`bundle too large: ${info.size} bytes > ${TRANSFER_MAX_BYTES}`)
  return { fileName: basename(path), path, text: await readFile(path, 'utf8') }
}

/**
 * Snapshot everything an import may touch, with a manifest that also records
 * which targets did not exist yet (so rollback can delete them again).
 */
async function snapshotForImport(config, sessionIds) {
  const root = memoryRootOf(config)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = join(root, 'memory-backup', `import-${stamp}`)
  await mkdir(dir, { recursive: true })
  const files = []
  const record = async (relPath, backupName) => {
    try {
      await copyFile(join(root, relPath), join(dir, backupName))
      files.push({ relPath, backupName, state: 'saved' })
    } catch {
      files.push({ relPath, backupName, state: 'absent' })
    }
  }
  await record('profile.json', 'profile.json')
  await record('global.json', 'global.json')
  for (const id of sessionIds) await record(join('sessions', `${safeSessionId(id)}.json`), `${safeSessionId(id)}.json`)
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ kind: 'dsh-memory-import-snapshot', at: Date.now(), files }, null, 2))
  return `import-${stamp}`
}

/** Restore an import snapshot: put saved files back, delete the ones it created. */
async function rollbackImportSnapshot(config, snapshotName) {
  const root = memoryRootOf(config)
  const safe = String(snapshotName ?? '').replace(/[^A-Za-z0-9._-]/g, '')
  const dir = join(root, 'memory-backup', safe)
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
  const restored = []
  const removed = []
  for (const entry of manifest.files ?? []) {
    const target = join(root, entry.relPath)
    const sessionId = entry.relPath.startsWith('sessions/') ? entry.relPath.slice('sessions/'.length).replace(/\.json$/, '') : null
    if (entry.state === 'saved') {
      await mkdir(dirname(target), { recursive: true })
      await copyFile(join(dir, entry.backupName), target)
      restored.push(entry.relPath)
      if (sessionId !== null) {
        await indexRemove(config, { sessionId })
        const doc = await readSessionMemory(config, sessionId)
        for (const memory of doc?.memories ?? []) {
          await indexUpsert(config, { sessionId, memoryId: memory.id, category: memory.category, content: memory.content, createdAt: memory.createdAt })
        }
      }
    } else {
      await rm(target, { force: true })
      removed.push(entry.relPath)
      if (sessionId !== null) {
        await indexRemove(config, { sessionId })
        const entries = await readGlobal(config)
        const next = entries.filter((entry) => entry.sessionId !== sessionId)
        if (next.length !== entries.length) await writeGlobal(config, next)
      }
    }
  }
  return { ok: true, snapshot: safe, restored, removed }
}

/** Apply an import plan. The caller holds the global lock. */
async function applyImport(config, bundle, plan, options) {
  const touched = new Set()
  const report = {
    created: [], merged: [], skipped: [], replaced: [], rejected: [],
    profileAdded: 0, profileSkipped: plan.profileSkips.length, profileReplaced: false,
    entriesBuilt: [], entriesRejected: plan.rejectedEntries, remapped: [],
  }
  const snapshot = await snapshotForImport(config, bundle.sessions.map((session) => session.sessionId))

  if (plan.profileAdds.length > 0 || options.replaceProfile === true) {
    const profile = await readProfile(config)
    if (options.replaceProfile === true && isRecord(bundle.profile) && isRecord(bundle.profile.sections)) {
      for (const section of PROFILE_SECTIONS) {
        profile.sections[section] = (Array.isArray(bundle.profile.sections[section]) ? bundle.profile.sections[section] : [])
          .map((point) => String(point).trim()).filter(Boolean).slice(0, 200)
      }
      report.profileReplaced = true
    } else {
      for (const { section, text } of plan.profileAdds) {
        if (!profilePointCovered(profile.sections[section], text)) profile.sections[section].push(text)
      }
      report.profileAdded = plan.profileAdds.length
    }
    profile.updatedAt = Date.now()
    await writeProfile(config, profile)
  }

  const bundleEntryFor = new Map(bundle.global.map((entry) => [entry.sessionId, entry]))
  for (const sessionPlan of plan.sessions) {
    const source = bundle.sessions.find((session) => session.sessionId === sessionPlan.sessionId)
    if (source === undefined) continue
    const incoming = {
      sessionId: source.sessionId,
      title: source.title ?? null,
      summary: null,
      memories: (Array.isArray(source.memories) ? source.memories : []).map((memory) => ({
        id: String(memory.id),
        content: String(memory.content ?? ''),
        category: memory.category ?? DEFAULT_CATEGORY,
        createdAt: Number.isFinite(memory.createdAt) ? memory.createdAt : Date.now(),
      })),
      updatedAt: Date.now(),
      ...(isRecord(source.origin) ? { origin: source.origin } : {}),
    }
    if (incoming.memories.length === 0) continue

    const remapped = options.remapSessions === true && sessionPlan.mode !== 'create'
    const targetId = remapped ? `session-imported-${randomUUID().slice(0, 8)}` : source.sessionId
    const mode = remapped ? 'create' : sessionPlan.mode
    if (remapped) report.remapped.push({ from: source.sessionId, to: targetId })

    if (mode === 'skip') {
      report.skipped.push({ sessionId: targetId, memories: incoming.memories.length, reason: 'on-existing=skip' })
      continue
    }
    if (mode === 'create' || mode === 'replace') {
      const doc = { ...incoming, sessionId: targetId }
      if (remapped) doc.origin = { ...(isRecord(doc.origin) ? doc.origin : {}), originSessionId: source.sessionId }
      collapseSessionMemories(doc) // one memory per session, also for incoming bundles
      await writeSessionMemory(config, targetId, doc)
      touched.add(targetId)
      if (mode === 'replace') report.replaced.push({ sessionId: targetId })
      else report.created.push({ sessionId: targetId, memories: doc.memories.length })
      continue
    }
    // merge: imported content is applied like one more save to that session.
    const doc = (await readSessionMemory(config, targetId)) ?? { sessionId: targetId, title: null, summary: null, memories: [], updatedAt: null }
    const bytesOf = (value) => value.memories.reduce((total, memory) => total + Array.from(String(memory.content ?? '')).length, 0)
    const bytesBefore = bytesOf(doc)
    let outcome = { merged: false, created: false, reason: 'empty' }
    let overflow = null
    for (const memory of incoming.memories) {
      outcome = mergeIntoSessionMemory(doc, String(memory.content ?? ''), memory.category ?? DEFAULT_CATEGORY)
      if (outcome.merged !== true && outcome.created !== true) {
        overflow = outcome.reason ?? 'no-change'
        break
      }
    }
    if (outcome.merged === true || outcome.created === true) {
      if (doc.title === null && typeof source.title === 'string' && source.title.length > 0) doc.title = source.title
      await writeSessionMemory(config, targetId, doc)
      touched.add(targetId)
      report.merged.push({ sessionId: targetId, bytesBefore, bytesAfter: bytesOf(doc) })
    } else if (outcome.reason !== undefined && /would reach/.test(String(outcome.reason))) {
      report.rejected.push({ sessionId: targetId, reason: outcome.reason, overflow })
    } else {
      report.skipped.push({ sessionId: targetId, memories: incoming.memories.length, reason: String(outcome.reason ?? 'no-change') })
    }
  }

  for (const sessionId of touched) {
    await indexRemove(config, { sessionId })
    const doc = await readSessionMemory(config, sessionId)
    for (const memory of doc?.memories ?? []) {
      await indexUpsert(config, { sessionId, memoryId: memory.id, category: memory.category, content: memory.content, createdAt: memory.createdAt })
    }
    const originId = report.remapped.find((row) => row.to === sessionId)?.from ?? sessionId
    const bundleEntry = bundleEntryFor.get(originId)
    await upsertSessionEntryLocked(config, sessionId, {
      keyPoint: typeof bundleEntry?.keyPoints === 'string' && bundleEntry.keyPoints.length > 0 ? bundleEntry.keyPoints : undefined,
      title: typeof doc?.title === 'string' && doc.title.length > 0 ? doc.title : (typeof bundleEntry?.title === 'string' ? bundleEntry.title : undefined),
      category: doc?.memories?.[0]?.category ?? bundleEntry?.category,
      lastActivity: doc?.updatedAt,
    })
  }
  for (const sessionId of plan.entriesToBuild) {
    if (touched.has(sessionId)) continue
    const doc = await readSessionMemory(config, sessionId)
    const first = doc?.memories?.[0]
    if (doc === null || first === undefined) continue
    await upsertSessionEntryLocked(config, sessionId, {
      keyPoint: normalizeKeyPoint(undefined, first.content),
      title: typeof doc.title === 'string' && doc.title.length > 0 ? doc.title : undefined,
      category: first.category,
      lastActivity: doc.updatedAt,
    })
    report.entriesBuilt.push(sessionId)
  }

  const audit = await auditMemoryLinks(config)
  return {
    snapshot,
    report,
    audit: { missingEntries: audit.missingEntries.length, orphanEntries: audit.orphanEntries.length },
  }
}

async function listSessionSummaries(config) {
  const rows = []
  for (const sessionId of await listSessionFiles(config)) {
    const doc = await readSessionMemory(config, sessionId)
    if (doc === null) continue
    const memories = Array.isArray(doc.memories) ? doc.memories : []
    rows.push({
      sessionId,
      title: typeof doc.title === 'string' && doc.title.length > 0 ? doc.title : null,
      count: memories.length,
      updatedAt: Number.isFinite(doc.updatedAt) ? doc.updatedAt : null,
      bytes: Buffer.byteLength(JSON.stringify(memories), 'utf8'),
    })
  }
  rows.sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
  return rows
}

/** One session's full memories for the editor. */
async function readSessionDetail(config, sessionId) {
  const id = safeSessionId(sessionId)
  const doc = await readSessionMemory(config, id)
  if (doc === null) return null
  return {
    sessionId: id,
    title: typeof doc.title === 'string' && doc.title.length > 0 ? doc.title : null,
    updatedAt: Number.isFinite(doc.updatedAt) ? doc.updatedAt : null,
    memories: (Array.isArray(doc.memories) ? doc.memories : []).map((memory) => ({
      id: String(memory.id ?? ''),
      content: String(memory.content ?? ''),
      category: typeof memory.category === 'string' ? memory.category : DEFAULT_CATEGORY,
      createdAt: Number.isFinite(memory.createdAt) ? memory.createdAt : null,
    })),
  }
}

/** Editor view: the five profile sections plus the compact global index. */
async function readStoreView(config, override = {}) {
  const profile = await readProfile(config)
  const entries = await readGlobal(config)
  const points = PROFILE_SECTIONS.reduce((total, section) => total + profile.sections[section].length, 0)
  const sessionIdSet = new Set(await listSessionFiles(config))
  return {
    ok: true,
    root: memoryRootOf(config),
    profile: { updatedAt: profile.updatedAt ?? null, sections: profile.sections },
    global: entries.map((entry) => ({
      id: entry.id,
      sessionId: entry.sessionId,
      title: entry.title ?? '',
      keyPoints: entry.keyPoints ?? '',
      category: entry.category ?? DEFAULT_CATEGORY,
      lastActivity: entry.lastActivity ?? null,
      linked: typeof entry.sessionId === 'string' && sessionIdSet.has(entry.sessionId),
    })),
    injection: injectionMetrics(config, profile, entries, override),
    limits: {
      profilePoints: config.maxProfilePoints ?? DEFAULT_MAX_PROFILE_POINTS,
      injectLimit: configNumber(config.injectLimit, DEFAULT_INJECT_LIMIT),
      maxInjectBytes: configNumber(config.maxInjectBytes, DEFAULT_MAX_INJECT_BYTES),
    },
    stats: { profilePoints: points, globalEntries: entries.length },
  }
}

/**
 * Apply editor operations under the store lock. Field-level ops only: an editor
 * never replaces the whole file, so a concurrent model write survives.
 */
function applyStoreOps(webCtx, config, ops) {
  const maxProfilePoints = config.maxProfilePoints ?? DEFAULT_MAX_PROFILE_POINTS
  return withGlobalLock(config, async () => {
    const profile = await readProfile(config)
    const entries = await readGlobal(config)
    let changed = 0
    let profileChanged = false
    let globalChanged = false
    const configWrites = []
    const actions = []
    const reject = (message) => ({ ok: false, code: 'rejected', message })

    for (const raw of ops) {
      const op = isRecord(raw) ? raw : null
      if (op === null || typeof op.op !== 'string') return reject('each operation needs an "op"')

      if (op.op === 'profile.replace') {
        const section = normalizeProfileSection(op.section)
        if (section === null) return reject(`unknown profile section ${JSON.stringify(op.section)}`)
        if (!Array.isArray(op.points)) return reject('profile.replace needs a points array')
        const cleaned = []
        for (const point of op.points) {
          const text = typeof point === 'string' ? point.trim() : ''
          if (!text) continue
          if (text.length > BRIDGE_POINT_MAX_CHARS) {
            return reject(`profile point exceeds ${BRIDGE_POINT_MAX_CHARS} characters`)
          }
          if (!cleaned.includes(text)) cleaned.push(text)
        }
        if (cleaned.length > maxProfilePoints) {
          return reject(`profile.${section} exceeds the ${maxProfilePoints}-point limit`)
        }
        profile.sections[section] = cleaned
        changed++
        profileChanged = true
        continue
      }

      if (op.op === 'global.update') {
        const entry = entries.find((candidate) => candidate.id === op.id)
        if (entry === undefined) return reject(`no global entry with id ${JSON.stringify(op.id)}`)
        if (typeof op.title === 'string') entry.title = op.title.trim().slice(0, BRIDGE_TITLE_MAX_CHARS)
        if (typeof op.keyPoints === 'string') {
          entry.keyPoints = normalizeKeyPoint(op.keyPoints.trim().slice(0, BRIDGE_POINT_MAX_CHARS), '')
        }
        if (typeof op.category === 'string') {
          const category = op.category.trim().slice(0, BRIDGE_CATEGORY_MAX_CHARS)
          entry.category = category.length > 0 ? category : DEFAULT_CATEGORY
        }
        changed++
        globalChanged = true
        continue
      }

      if (op.op === 'global.remove') {
        const index = entries.findIndex((candidate) => candidate.id === op.id)
        if (index < 0) return reject(`no global entry with id ${JSON.stringify(op.id)}`)
        const linked = entries[index].sessionId
        if (typeof linked === 'string' && linked.length > 0 && (await readSessionMemory(config, linked)) !== null) {
          return reject(`条目 ${op.id} 关联会话 ${linked} 的记忆：索引与会话记忆必须一一对应，请改用「会话记忆 → 删除整会话」（或删除该会话的全部记忆）`)
        }
        entries.splice(index, 1)
        changed++
        globalChanged = true
        continue
      }

      if (op.op === 'doctor.repair') {
        const result = await repairMemoryLinks(config)
        actions.push(...result.actions)
        changed++
        continue
      }

      if (op.op === 'memory.replace') {
        // Rewrite (not append) the session's single memory. Keeps the id and
        // createdAt, restarts mergedCount, and re-syncs the derived index and the
        // session's entry — the same invariants a save maintains.
        const sessionId = safeSessionId(op.sessionId)
        const doc = await readSessionMemory(config, sessionId)
        if (doc === null) return reject(`no session file for ${sessionId}`)
        const content = String(op.content ?? '').trim()
        if (content.length === 0) return reject('memory.replace: content is required')
        const length = Array.from(content).length
        if (length > SESSION_MEMORY_MAX_CHARS) return reject(`memory.replace: content is ${length} characters, over the ${SESSION_MEMORY_MAX_CHARS} ceiling`)
        const single = doc.memories[0]
        const category = typeof op.category === 'string' && op.category.length > 0
          ? op.category
          : (single?.category ?? DEFAULT_CATEGORY)
        const now = Date.now()
        const next = {
          id: typeof single?.id === 'string' && single.id.length > 0 ? single.id : randomUUID(),
          content,
          category,
          createdAt: Number.isFinite(single?.createdAt) ? single.createdAt : now,
          updatedAt: now,
          mergedCount: 1,
        }
        doc.memories = [next]
        doc.updatedAt = now
        if (typeof op.title === 'string' && op.title.trim().length > 0) doc.title = op.title.trim()
        await writeSessionMemory(config, sessionId, doc)
        await indexRemove(config, { sessionId })
        await indexUpsert(config, {
          sessionId,
          memoryId: next.id,
          category: next.category,
          content: next.content,
          createdAt: next.createdAt,
        })
        const keyPoint = typeof op.keyPoint === 'string' && op.keyPoint.trim().length > 0
          ? op.keyPoint.trim()
          : normalizeKeyPoint(undefined, content)
        await upsertSessionEntryLocked(config, sessionId, {
          keyPoint,
          title: typeof op.title === 'string' && op.title.trim().length > 0 ? op.title.trim() : (typeof doc.title === 'string' ? doc.title : undefined),
          category: next.category,
          lastActivity: now,
        })
        actions.push(`重写记忆：${sessionId}（${length} 字）`)
        changed++
        continue
      }

      if (op.op === 'session.collapse') {
        const sessionId = safeSessionId(op.sessionId)
        const doc = await readSessionMemory(config, sessionId)
        if (doc === null) return reject(`no session file for ${sessionId}`)
        if (doc.memories.length <= 1) {
          changed++
          continue
        }
        const count = doc.memories.length
        collapseSessionMemories(doc)
        doc.updatedAt = Date.now()
        await writeSessionMemory(config, sessionId, doc)
        await indexRemove(config, { sessionId })
        for (const memory of doc.memories) {
          await indexUpsert(config, {
            sessionId,
            memoryId: memory.id,
            category: memory.category,
            content: memory.content,
            createdAt: memory.createdAt,
          })
        }
        await upsertSessionEntryLocked(config, sessionId, { keyPoint: undefined, title: doc.title ?? undefined, category: doc.memories[0]?.category, lastActivity: doc.updatedAt })
        actions.push(`折叠为一条：${sessionId}（${count} → 1 条）`)
        changed++
        continue
      }

      if (op.op === 'memory.remove') {
        const sessionId = safeSessionId(op.sessionId)
        const doc = await readSessionMemory(config, sessionId)
        if (doc === null) return reject(`no session file for ${sessionId}`)
        const memoryId = String(op.memoryId ?? '')
        const before = doc.memories.length
        doc.memories = doc.memories.filter((memory) => String(memory.id) !== memoryId)
        if (doc.memories.length === before) return reject(`no memory ${memoryId} in ${sessionId}`)
        doc.updatedAt = Date.now()
        await writeSessionMemory(config, sessionId, doc)
        // The derived index must not keep serving the deleted text.
        await indexRemove(config, { memoryId })
        changed++
        continue
      }

      if (op.op === 'session.remove') {
        const sessionId = safeSessionId(op.sessionId)
        const file = sessionPathOf(memoryRootOf(config), sessionId)
        try {
          await rm(file, { force: true })
        } catch (error) {
          return reject(`could not remove ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
        }
        await indexRemove(config, { sessionId })
        const at = entries.findIndex((entry) => entry.sessionId === sessionId)
        if (at >= 0) {
          entries.splice(at, 1)
          globalChanged = true
        }
        changed++
        continue
      }

      if (op.op === 'config.set') {
        if (BRIDGE_CONFIG_STRING_FIELDS.includes(op.field)) {
          if (typeof op.value !== 'string' || op.value.length > 200) {
            return reject(`config ${op.field} must be a string of at most 200 characters`)
          }
          const text = op.value.trim()
          configWrites.push({ field: op.field, value: text === 'default' ? '' : text, string: true })
          continue
        }
        if (!BRIDGE_CONFIG_FIELDS.includes(op.field)) {
          return reject(`config field ${JSON.stringify(op.field)} is not editable here`)
        }
        const value = Number(op.value)
        const ceiling = op.field === 'injectLimit' ? 500 : 1024 * 1024
        if (!Number.isFinite(value) || Math.floor(value) !== value || value < 1 || value > ceiling) {
          return reject(`config ${op.field} must be an integer between 1 and ${ceiling}`)
        }
        configWrites.push({ field: op.field, value })
        continue
      }

      return reject(`unknown operation ${JSON.stringify(op.op)}`)
    }

    if (changed > 0) {
      // Only the touched file is rewritten, so an edit to one tier never bumps
      // the other tier's timestamp (and its injected snapshot stays put).
      if (profileChanged) {
        profile.updatedAt = Date.now()
        await writeProfile(config, profile)
      }
      if (globalChanged) await writeGlobal(config, entries)
    }

    // Config writes go through the settings service so the value lands in this
    // profile's Cordis patch with the same revision guard the settings UI uses.
    const override = {}
    if (configWrites.length > 0) {
      const settings = typeof webCtx.get === 'function' ? webCtx.get('settings') : undefined
      if (settings === undefined || typeof settings.mutate !== 'function') {
        return reject('the settings service is unavailable; edit cordis.patch.yml instead')
      }
      try {
        await settings.mutate(
          name,
          configWrites.map((write) => ({ op: 'set', path: [write.field], value: write.value })),
        )
      } catch (error) {
        return reject(`config write refused: ${error instanceof Error ? error.message : String(error)}`)
      }
      for (const write of configWrites) if (write.string !== true) override[write.field] = write.value
      changed += configWrites.length
    }

    const view = await readStoreView(config, override)
    return actions.length > 0 ? { ...view, changed, actions } : { ...view, changed }
  })
}


/* ------------------- memory consolidation (v2.7) ------------------------ */
/*
 * "Dream"-style condensing. The plugin makes its own one-shot ctx.llm.stream()
 * call, so the conversation pays nothing, and returns a DRAFT: nothing is
 * written until the operator applies it, and applying snapshots both files
 * first. Both tiers are compressed *views* — the session files stay untouched —
 * so merging or dropping an index entry costs discoverability from the injected
 * index, never the memories themselves.
 */

const CONSOLIDATE_PATH = '/api/dsh-memory-consolidate'
const CONSOLIDATION_DRAFT_TTL_MS = 30 * 60 * 1000
const CONSOLIDATION_DEFAULT_TOKENS = 32768
/** Anchors a draft must not lose: URLs, file names, uuids, hashes, numbers. */
const ANCHOR_PATTERN = /(?:https?:\/\/[^\s"'`)\]]+)|(?:[\w./-]+\.(?:ts|tsx|js|mjs|cjs|json|jsonl|yml|yaml|toml|md|py|sh|zsh|sql|db)\b)|(?:\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b)|(?:\b[0-9a-f]{7,40}\b)|(?:\b\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?\b)|(?:\b\d{4,}\b)/gi

let consolidationDraft = null
/** Whether this instance registered the /dream command (surfaced for the page). */
let dreamCommandRegistered = false
/** Most recent consolidation attempt (also the head of the persisted log). */
let consolidationLastRun = null
/** Last session-link scan (derived state; never persisted). */
let sessionLinkScan = null
/** Persisted run history, loaded lazily from `consolidation-log.json`. */
let consolidationHistory = null
let consolidationWriteChain = Promise.resolve()
const CONSOLIDATION_LOG_LIMIT = 50

function consolidationLogPathOf(root) {
  return join(root, 'consolidation-log.json')
}

/** History newest-first, read from disk once per plugin instance. */
function loadConsolidationHistory(config) {
  if (consolidationHistory !== null) return consolidationHistory
  const rows = readJsonSync(consolidationLogPathOf(memoryRootOf(config)), [])
  consolidationHistory = Array.isArray(rows) ? rows.slice(0, CONSOLIDATION_LOG_LIMIT) : []
  return consolidationHistory
}

/** Append one run record and flush the whole log, serialized in-process. */
function persistConsolidationRun(config, record) {
  const rows = loadConsolidationHistory(config)
  rows.unshift(record)
  if (rows.length > CONSOLIDATION_LOG_LIMIT) rows.length = CONSOLIDATION_LOG_LIMIT
  consolidationWriteChain = consolidationWriteChain
    .catch(() => {})
    .then(() => writeJson(consolidationLogPathOf(memoryRootOf(config)), rows))
    .catch(() => {})
  return record
}

function recordConsolidationRun(config, ok, code, target, usage, startedAt, outputChars, evaluation) {
  const metrics = evaluation?.metrics
  const counts = evaluation?.counts
  const record = {
    at: Date.now(),
    ok,
    code: code ?? null,
    provider: target?.provider ?? null,
    model: target?.model ?? null,
    reasoningEffort: target?.reasoningEffort ?? null,
    outputTokens: Number.isFinite(usage?.outputTokens) ? usage.outputTokens : null,
    totalTokens: Number.isFinite(usage?.totalTokens) ? usage.totalTokens : null,
    elapsedMs: Date.now() - startedAt,
    outputChars: outputChars ?? null,
    beforeTokens: metrics?.before?.total?.tokens ?? null,
    afterTokens: metrics?.after?.total?.tokens ?? null,
    profileBefore: metrics?.before?.profile?.tokens ?? null,
    profileAfter: metrics?.after?.profile?.tokens ?? null,
    indexBefore: metrics?.before?.index?.tokens ?? null,
    indexAfter: metrics?.after?.index?.tokens ?? null,
    pointsBefore: counts?.beforePoints ?? null,
    pointsAfter: counts?.afterPoints ?? null,
    entriesBefore: counts?.beforeEntries ?? null,
    entriesAfter: counts?.afterEntries ?? null,
    lostCritical: Array.isArray(evaluation?.lostCritical) ? evaluation.lostCritical.length : null,
    regression: typeof evaluation?.regression === 'boolean' ? evaluation.regression : null,
  }
  consolidationLastRun = record
  return persistConsolidationRun(config, record)
}

function collectAnchors(text) {
  const found = new Set()
  for (const match of String(text).matchAll(ANCHOR_PATTERN)) found.add(match[0].toLowerCase())
  return found
}

function rerender(sections, entries, injectLimit, maxInjectBytes) {
  return composeInjection({ version: 1, updatedAt: null, sections }, entries, injectLimit, maxInjectBytes)
}

/**
 * Turn a draft into the store it proposes. Profile sections may be omitted (the
 * current ones are kept); index rows carry `fromIds`, whose first entry is the
 * surviving id and whose remainder are the merged-away sources.
 */
export function draftToStore(sections, entries, draft) {
  const nextSections = {}
  for (const section of PROFILE_SECTIONS) {
    const raw = isRecord(draft.sections) ? draft.sections[section] : undefined
    // "One paragraph per section": a string is the intended shape now, while a
    // list (either the legacy many-point form or a one-element array) still works.
    const proposed = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : sections[section]
    const points = proposed.map((point) => String(point).trim()).filter(Boolean)
    // A section that came back as prose is kept as exactly one entry.
    nextSections[section] = (typeof raw === 'string' ? points.slice(0, 1) : points).slice(0, 200)
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const rows = Array.isArray(draft.global) ? draft.global : []
  const nextEntries = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const fromIds = (Array.isArray(row.fromIds) ? row.fromIds : []).filter((id) => byId.has(id))
    const primary = fromIds[0] ?? (typeof row.id === 'string' && byId.has(row.id) ? row.id : undefined)
    if (primary === undefined) continue
    const source = byId.get(primary)
    const mergedFrom = fromIds.slice(1)
    const row2 = {
      ...source,
      id: primary,
      title: String(row.title ?? source.title ?? '').trim().slice(0, BRIDGE_TITLE_MAX_CHARS) || source.title,
      keyPoints: normalizeKeyPoint(String(row.keyPoints ?? source.keyPoints ?? ''), ''),
      category: String(row.category ?? source.category ?? DEFAULT_CATEGORY).trim().slice(0, BRIDGE_CATEGORY_MAX_CHARS) || DEFAULT_CATEGORY,
    }
    if (mergedFrom.length > 0) row2.mergedFrom = mergedFrom
    nextEntries.push(row2)
  }
  nextEntries.sort((a, b) => Number(b.lastActivity ?? 0) - Number(a.lastActivity ?? 0))
  return { sections: nextSections, entries: nextEntries }
}

/**
 * Score a draft against the current store. Pure: used by the route and by tests.
 * @returns `{ok:false, code, message}` for an unusable draft, otherwise the
 *   before/after metrics, the anchors it would lose, and what it merges/drops.
 */
export function evaluateConsolidation(input, draft) {
  const next = draftToStore(input.sections, input.entries, draft)
  if (next.entries.length === 0) return { ok: false, code: 'empty-draft', message: '整理建议没有给出任何索引条目' }
  const beforeText = rerender(input.sections, input.entries, input.injectLimit, input.maxInjectBytes)
  const afterText = rerender(next.sections, next.entries, input.injectLimit, input.maxInjectBytes)
  const beforeMetrics = injectionMetrics({}, { sections: input.sections, updatedAt: null }, input.entries, input)
  const afterMetrics = injectionMetrics({}, { sections: next.sections, updatedAt: null }, next.entries, input)
  const lostCritical = []
  for (const anchor of collectAnchors(beforeText)) {
    if (!afterText.toLowerCase().includes(anchor)) lostCritical.push(anchor)
  }
  const kept = new Set(next.entries.map((entry) => entry.id))
  const counted = (store) => PROFILE_SECTIONS.reduce((total, section) => total + store[section].length, 0)
  return {
    ok: true,
    next,
    metrics: { before: beforeMetrics, after: afterMetrics },
    regression: afterMetrics.total.tokens >= beforeMetrics.total.tokens,
    lostCritical,
    removed: input.entries.filter((entry) => !kept.has(entry.id)).map((entry) => ({ id: entry.id, title: entry.title })),
    merged: next.entries.filter((entry) => Array.isArray(entry.mergedFrom)).map((entry) => ({ id: entry.id, title: entry.title, from: entry.mergedFrom })),
    counts: {
      beforePoints: counted(input.sections),
      afterPoints: counted(next.sections),
      beforeEntries: input.entries.length,
      afterEntries: next.entries.length,
    },
  }
}

/**
 * Resolve the consolidation model. The operator owns this choice: only an
 * explicit per-run request or the saved profile config is accepted, and an
 * unset pair is an error the page must surface — never a silent fallback to
 * the conversation's route or to any other model this plugin can see.
 */
function resolveConsolidationTarget(config, webCtx, request) {
  const fromRequest = (field) => (typeof request?.[field] === 'string' && request[field].trim().length > 0 ? request[field].trim() : null)
  const provider = fromRequest('provider') ?? configString(config.consolidationProvider, null)
  const model = fromRequest('model') ?? configString(config.consolidationModel, null)
  if (provider === null || model === null) return null
  const effortRaw = fromRequest('reasoningEffort') ?? configString(config.consolidationReasoningEffort, null)
  const reasoningEffort = effortRaw === null || effortRaw === 'default' ? null : effortRaw
  const maxTokens = Number.isFinite(Number(request?.maxTokens))
    ? Math.max(256, Math.floor(Number(request.maxTokens)))
    : (Number.isFinite(Number(config.consolidationMaxTokens)) && Number(config.consolidationMaxTokens) > 0
        ? Math.floor(Number(config.consolidationMaxTokens))
        : CONSOLIDATION_DEFAULT_TOKENS)
  const fallbackSession = typeof request?.sessionId === 'string' && request.sessionId.trim().length > 0
    ? request.sessionId.trim()
    : 'dsh-memory-consolidation'
  return {
    provider,
    model,
    maxTokens,
    sessionId: fallbackSession,
    reasoningEffort,
    source: fromRequest('provider') !== null || fromRequest('model') !== null ? 'request' : 'config',
  }
}

/** Advertise the models the operator may choose, with each route's efforts. */
async function consolidationCatalog(webCtx, provider) {
  const llm = typeof webCtx.get === 'function' ? webCtx.get('llm') : undefined
  if (llm === undefined || typeof llm.listModels !== 'function') {
    return { ok: false, code: 'llm-unavailable', message: 'llm 服务不可用' }
  }
  let providers = []
  try {
    providers = (typeof llm.listProviders === 'function' ? llm.listProviders() : []).map((entry) => ({ id: entry.id, name: entry.name ?? entry.id }))
  } catch {
    providers = []
  }
  if (typeof provider !== 'string' || provider.length === 0) return { ok: true, providers, models: [] }
  let models = []
  try {
    models = await llm.listModels(provider)
  } catch (error) {
    return { ok: false, code: 'catalog-failed', message: error instanceof Error ? error.message : String(error), providers }
  }
  const rows = []
  for (const model of models) {
    let efforts = []
    let defaultEffort = null
    try {
      const info = await llm.resolveModelInfo(provider, model.id)
      const reasoning = info?.reasoning
      if (reasoning !== undefined && Array.isArray(reasoning.efforts)) {
        efforts = reasoning.efforts.map((effort) => ({ id: effort.id, name: effort.name ?? effort.id }))
      }
      defaultEffort = reasoning?.defaultEffort ?? null
    } catch {
      /* a model whose metadata cannot be read still appears, without efforts */
    }
    rows.push({ id: model.id, name: model.name ?? model.id, efforts, defaultEffort })
  }
  rows.sort((a, b) => a.id.localeCompare(b.id))
  return { ok: true, providers, provider, models: rows }
}

export const SESSION_CONSOLIDATION_INSTRUCTION = [
  '下面是 dsh-memory 某个会话的**全部记忆**。请把它们**合成一条**记忆，输出 JSON：',
  '{"content":"...","category":"...","keyPoint":"≤50字的整段摘要"}',
  '规则：',
  '1. **只输出一条 content**：把全部仍然有效的事实写进这同一个 content，按主题顺次陈述（用换行或中文分号分隔），不要输出数组、不要分条。',
  '2. 删除重复表述；**删除已被后续记忆推翻的内容**（同一事实以最新的为准）；删除已失效的做法、临时状态与过时结论。',
  '   被推翻的旧值要**彻底删除**，不要写"此前误记为…/曾用…"这类沿革说明——它们属于过时信息，没有保留价值。',
  '3. 保留所有仍然有效的路径、文件名、命令、URL、哈希、编号、数字、专有名词；只做合并与取舍，不新增事实、不做推断。',
  '4. **内容分工**：只保留结论、当前状态、不可从仓库或文档反推的取舍、坐标（路径/命令/编号/版本号）与**指针**（过程档案的位置）；',
  '   **优先删除**过程性叙述、实测数字、踩坑经过、沿革说明与提交哈希——它们属于项目文档，不属于记忆。',
  '5. 目标：字符数降到原来的 40% 以下，同时保持可读（读者能只看这一条就知道该会话的结论与去哪儿查细节）。',
  '6. **过程档案指针必须保留**：若材料中出现「过程档案」段落（形如 【过程档案】<路径>），结果中必须原样保留其路径，并写成"记忆不足以解决问题时进一步读取该文档"的引导句；不得因为压缩而删掉它。',
  '7. keyPoint 是给"全局索引"用的整段摘要（不超过 50 字），要与 content 保持一致。',
].join('\n')

/**
 * Turn a session draft into the memory list it proposes. Unlike the injected
 * tiers, a session rewrite is allowed to drop a memory outright (that is how
 * outdated or contradicted content leaves), so an empty list is a valid,
 * deliberate result rather than an error.
 */
function draftToSessionMemories(doc, draft) {
  const source = Array.isArray(doc.memories) ? doc.memories : []
  if (source.length === 0) return []
  // The newest entry is the one whose id and category survive the rewrite.
  const newest = source.reduce((best, memory) => (Number(memory.createdAt ?? 0) >= Number(best.createdAt ?? 0) ? memory : best), source[0])
  const rows = Array.isArray(draft.memories) ? draft.memories : []
  const content = String(
    draft.content
      ?? (rows.length > 0 ? rows.map((row) => (isRecord(row) ? String(row.content ?? '') : '')).filter(Boolean).join('\n') : ''),
  ).trim()
  if (content.length === 0) return []
  const category = String(draft.category ?? (isRecord(rows[0]) ? rows[0].category : '') ?? newest.category ?? DEFAULT_CATEGORY)
    .trim()
    .slice(0, BRIDGE_CATEGORY_MAX_CHARS) || DEFAULT_CATEGORY
  const memory = {
    id: String(newest.id),
    content: content.slice(0, BRIDGE_POINT_MAX_CHARS),
    category,
    createdAt: Date.now(),
    // Same bookkeeping the save path maintains: a synthesis starts a new segment.
    updatedAt: Date.now(),
    mergedCount: 1,
  }
  const absorbed = source.map((entry) => String(entry.id)).filter((id) => id !== memory.id)
  if (absorbed.length > 0) memory.mergedFrom = absorbed
  return [memory]
}

/** Score a session draft: volume drop, merged/dropped counts, lost anchors. */
export function evaluateSessionConsolidation(doc, draft) {
  const before = Array.isArray(doc.memories) ? doc.memories : []
  const next = draftToSessionMemories(doc, draft)
  const beforeText = before.map((memory) => String(memory.content ?? '')).join('\n')
  const afterText = next.map((memory) => String(memory.content ?? '')).join('\n')
  const lostCritical = []
  for (const anchor of collectAnchors(beforeText)) {
    if (!afterText.toLowerCase().includes(anchor)) lostCritical.push(anchor)
  }
  const kept = new Set(next.map((memory) => memory.id))
  return {
    ok: true,
    next,
    metrics: { before: { total: blockMetrics(beforeText) }, after: { total: blockMetrics(afterText) } },
    regression: blockMetrics(afterText).chars >= blockMetrics(beforeText).chars,
    lostCritical,
    removed: before.filter((memory) => !kept.has(String(memory.id))).map((memory) => ({ id: String(memory.id), title: String(memory.content ?? '').slice(0, 60) })),
    merged: next.filter((memory) => Array.isArray(memory.mergedFrom)).map((memory) => ({ id: memory.id, title: memory.content.slice(0, 60), from: memory.mergedFrom })),
    counts: { beforeMemories: before.length, afterMemories: next.length },
  }
}

const CONSOLIDATION_SYSTEM = '你是 dsh-memory 的记忆整理器。只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。'
const CONSOLIDATION_INSTRUCTION = [
  '下面是 dsh-memory 注入层的当前内容。请压缩它，输出 JSON：',
  '{"profile":{"sections":{"identity":"...","work":"...","personal":"...","technical":"...","style":"..."}},"global":[{"fromIds":["<现有 id>"],"title":"...","keyPoints":"≤50字","category":"..."}]}',
  '规则：',
  '1. 只压缩与合并，不新增事实、不改变含义、不做推断。',
  '2. 必须保留所有路径、文件名、URL、哈希、编号、数字、专有名词与命令；丢失锚点的方案会被拒绝。',
  '3. **画像**：五个分区各自**合成一段连贯的陈述**（字符串，不是数组、不要分条）：把该分区全部仍然有效的事实写进这一段，删除重复表述、删除已被后续说法推翻或已过时的内容；被推翻的旧值彻底删除，不要写"此前误记为…/曾用…"这类沿革说明。',
  '4. 每段不超过 300 字，段内可用中文分号分隔，不要换行、不要以"·"或"-"开头；某分区没有任何有效内容时给空字符串 ""。',
  '5. **索引**：**一个会话一条，不许丢弃、不许合并**。输出条数必须与输入完全一致，每条 `fromIds` 只写它自己原来那一个 id。会话记忆是条目的明细，条目一旦消失或被合并，对应会话的记忆就失去索引关联。只允许改写 title / keyPoints / category；keyPoints 不超过 50 字。',
  '6. 目标：注入总量降到整理前的 60% 以下。',
].join('\n')

async function runConsolidation(webCtx, config, request) {
  const startedAt = Date.now()
  const llm = typeof webCtx.get === 'function' ? webCtx.get('llm') : undefined
  if (llm === undefined || typeof llm.stream !== 'function') {
    return { ok: false, code: 'llm-unavailable', message: 'llm 服务不可用，无法生成整理建议' }
  }
  const target = resolveConsolidationTarget(config, webCtx, request)
  if (target === null) {
    return { ok: false, code: 'no-target', message: '尚未选择整理模型：请在页面上选择 provider / model 并保存后再生成（本插件不会自行挑选模型）' }
  }
  const scope = request?.scope === 'session' ? 'session' : 'injected'
  const profile = scope === 'injected' ? await readProfile(config) : null
  const entries = scope === 'injected' ? await readGlobal(config) : []
  const injectLimit = configNumber(config.injectLimit, DEFAULT_INJECT_LIMIT)
  const maxInjectBytes = configNumber(config.maxInjectBytes, DEFAULT_MAX_INJECT_BYTES)
  // Session scope condenses one session's memories instead of the injected tiers.
  let sessionDoc = null
  let sessionId = null
  let material
  let instruction
  if (scope === 'session') {
    sessionId = safeSessionId(request?.sessionId)
    sessionDoc = await readSessionMemory(config, sessionId)
    if (sessionDoc === null) {
      return { ok: false, code: 'no-session', message: `没有找到会话 ${sessionId} 的记忆文件` }
    }
    material = {
      sessionId,
      title: sessionDoc.title ?? null,
      memories: (Array.isArray(sessionDoc.memories) ? sessionDoc.memories : []).map((memory) => ({
        id: String(memory.id ?? ''),
        category: memory.category ?? DEFAULT_CATEGORY,
        content: String(memory.content ?? ''),
      })),
    }
    instruction = SESSION_CONSOLIDATION_INSTRUCTION
  } else {
    material = {
      profile: profile.sections,
      global: entries.map((entry) => ({ id: entry.id, title: entry.title, keyPoints: entry.keyPoints, category: entry.category })),
    }
    instruction = CONSOLIDATION_INSTRUCTION
  }

  const assembler = new BlockAssembler()
  const options = {
    provider: target.provider,
    model: target.model,
    system: CONSOLIDATION_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: `${instruction}\n\n${JSON.stringify(material, null, 2)}` }] }],
    maxTokens: target.maxTokens,
    sessionId: target.sessionId,
    ...target.reasoningEffort === null ? {} : { reasoningEffort: target.reasoningEffort },
  }
  let chunkCount = 0
  try {
    for await (const chunk of llm.stream(options)) {
      chunkCount++
      assembler.push(chunk)
    }
  } catch (error) {
    const run = recordConsolidationRun(config, false, 'llm-failed', target, assembler.usage ?? null, startedAt, null)
    return { ok: false, code: 'llm-failed', message: `整理调用失败：${error instanceof Error ? error.message : String(error)}`, target, run }
  }
  const finish = assembler.finish
  if (finish !== undefined && finish.kind === 'error') {
    const failure = finish.failure ?? {}
    return {
      ok: false,
      code: 'llm-refused',
      message: `上游拒绝了整理调用：${failure.message ?? '未知原因'}`,
      target,
      finish,
      run: recordConsolidationRun(config, false, 'llm-refused', target, assembler.usage ?? null, startedAt, null),
    }
  }
  const allBlocks = assembler.blocks()
  const answerText = allBlocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  const reasoningText = allBlocks.filter((block) => block.type === 'reasoning').map((block) => block.text).join('\n')
  const text = answerText.length > 0 ? answerText : reasoningText
  const parsed = parseConsolidationJson(text)
  if (parsed === null) {
    const finish = assembler.finish
    return {
      ok: false,
      code: 'unparsable',
      message: `模型输出不是合法 JSON（chunks=${chunkCount}, blocks=${assembler.blocks().map((b) => b.type).join('/') || 'none'}, text=${text.length}, finish=${String(finish?.kind ?? 'none')}${finish?.reason === undefined ? '' : `/${String(finish.reason)}`}）`,
      target,
      finish: finish ?? null,
      usage: assembler.usage ?? null,
      raw: text.slice(0, 600),
      run: recordConsolidationRun(config, false, 'unparsable', target, assembler.usage ?? null, startedAt, text.length),
    }
  }
  const draft = scope === 'session'
    ? {
        // The strategy is "synthesize one entry"; a legacy array is still accepted
        // so an older-style answer degrades gracefully instead of coming back empty.
        content: typeof parsed.content === 'string' ? parsed.content : null,
        category: typeof parsed.category === 'string' ? parsed.category : null,
        keyPoint: typeof parsed.keyPoint === 'string' ? parsed.keyPoint : null,
        memories: Array.isArray(parsed.memories) ? parsed.memories : [],
      }
    : {
        sections: isRecord(parsed.profile) ? parsed.profile.sections : (isRecord(parsed.sections) ? parsed.sections : null),
        global: Array.isArray(parsed.global) ? parsed.global : [],
      }
  const evaluation = scope === 'session'
    ? evaluateSessionConsolidation(sessionDoc, draft)
    : evaluateConsolidation({ sections: profile.sections, entries, injectLimit, maxInjectBytes }, draft)
  if (evaluation.ok !== true) return { ...evaluation, target, raw: text.slice(0, 600) }

  const token = randomUUID()
  consolidationDraft = { token, scope, sessionId, draft, evaluation, createdAt: Date.now(), target }
  const run = recordConsolidationRun(config, true, null, target, assembler.usage ?? null, startedAt, text.length, evaluation)
  return {
    ok: true,
    token,
    scope,
    sessionId,
    target,
    finish: assembler.finish,
    usage: assembler.usage ?? null,
    elapsedMs: run.elapsedMs,
    outputChars: text.length,
    // The proposed content travels with the draft so a reviewer can diff it
    // without a second round trip; nothing is written until apply.
    proposed: evaluation.next,
    run,
    evaluation: {
      metrics: evaluation.metrics,
      regression: evaluation.regression,
      lostCritical: evaluation.lostCritical,
      removed: evaluation.removed,
      merged: evaluation.merged,
      counts: evaluation.counts,
    },
  }
}

/** Apply the pending draft. Refuses regressions and lost anchors; snapshots first. */
function applyConsolidation(config, token) {
  const pending = consolidationDraft
  if (pending === null || pending.token !== token) {
    return Promise.resolve({ ok: false, code: 'no-draft', message: '整理建议已过期，请重新生成' })
  }
  if (Date.now() - pending.createdAt > CONSOLIDATION_DRAFT_TTL_MS) {
    consolidationDraft = null
    return Promise.resolve({ ok: false, code: 'no-draft', message: '整理建议已过期，请重新生成' })
  }
  const evaluation = pending.evaluation
  if (evaluation.regression) {
    return Promise.resolve({ ok: false, code: 'regression', message: '整理后注入量没有下降，已拒绝应用' })
  }
  // One session memory file must always keep exactly one index entry: dropping or
  // merging entries would leave that session's memories reachable only by full-text
  // search, which is exactly the broken link this guard exists to prevent.
  if (pending.scope !== 'session' && (evaluation.removed.length > 0 || evaluation.merged.length > 0)) {
    const parts = []
    if (evaluation.removed.length > 0) parts.push(`丢弃 ${evaluation.removed.length} 条`)
    if (evaluation.merged.length > 0) parts.push(`合并 ${evaluation.merged.length} 条`)
    return Promise.resolve({
      ok: false,
      code: 'entry-link-broken',
      message: `建议稿${parts.join('、')}索引条目，会断开这些会话的记忆与索引的关联，已拒绝应用。索引必须与会话记忆一一对应。`,
    })
  }
  // Injected scope compresses only, so losing an anchor is always a defect. Session
  // scope also *resolves contradictions*, so a deliberately dropped memory takes its
  // (outdated) values with it: there the list is reported, not enforced — the volume
  // regression check, the pre-apply snapshot, and the manual apply are the guards.
  if (evaluation.lostCritical.length > 0 && pending.scope !== 'session') {
    return Promise.resolve({
      ok: false,
      code: 'lost-anchors',
      message: `整理会丢失关键标识，已拒绝应用：${evaluation.lostCritical.slice(0, 8).join('、')}`,
    })
  }
  const root = memoryRootOf(config)
  return withGlobalLock(config, async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const snapshot = join(root, 'memory-backup', `consolidation-${stamp}`)
    await mkdir(snapshot, { recursive: true })
    if (pending.scope === 'session') {
      const file = sessionPathOf(root, pending.sessionId)
      try {
        await copyFile(file, join(snapshot, `${pending.sessionId}.json`))
      } catch {
        /* a missing source is not fatal */
      }
      const doc = await readSessionMemory(config, pending.sessionId)
      if (doc === null) return { ok: false, code: 'no-session', message: `会话 ${pending.sessionId} 的记忆文件已不存在` }
      doc.memories = evaluation.next
      doc.updatedAt = Date.now()
      await writeSessionMemory(config, pending.sessionId, doc)
      // The derived index keys on memoryId, and merged rows keep only the first
      // id, so clear the session's rows and re-insert the survivors.
      await indexRemove(config, { sessionId: pending.sessionId })
      for (const memory of evaluation.next) {
        await indexUpsert(config, {
          sessionId: pending.sessionId,
          memoryId: memory.id,
          category: memory.category,
          content: memory.content,
          createdAt: memory.createdAt,
        })
      }
      // The entry is the only handle on these memories: refresh it (and create it
      // when missing) so the rewrite can never leave the session unlinked.
      const keyPoint = normalizeKeyPoint(pending.draft?.keyPoint, evaluation.next[0]?.content ?? '')
      const entry = await upsertSessionEntryLocked(config, pending.sessionId, {
        keyPoint,
        title: typeof doc.title === 'string' ? doc.title : undefined,
        category: evaluation.next[0]?.category,
        lastActivity: doc.updatedAt,
      })
      consolidationDraft = null
      return {
        ...(await readStoreView(config)),
        applied: true,
        scope: 'session',
        sessionId: pending.sessionId,
        entry: { id: entry.id, keyPoints: entry.keyPoints },
        snapshot,
        changed: 1,
      }
    }
    for (const file of [profilePathOf(root), globalPathOf(root)]) {
      try {
        await copyFile(file, join(snapshot, file.split(/[\\/]/).pop()))
      } catch {
        /* a missing source is not fatal */
      }
    }
    const profile = await readProfile(config)
    profile.sections = evaluation.next.sections
    profile.updatedAt = Date.now()
    profile.consolidatedAt = profile.updatedAt
    await writeProfile(config, profile)
    await writeGlobal(config, evaluation.next.entries)
    consolidationDraft = null
    return { ...(await readStoreView(config)), applied: true, snapshot, changed: 1 }
  })
}

/**
 * Extract a JSON object from model output. Reasoning-heavy models emit prose
 * (which often quotes the requested schema, braces included) before the answer,
 * so fenced blocks win and otherwise the LAST balanced object is tried first.
 * Exported for tests.
 */
export function parseConsolidationJson(text) {
  const source = String(text)
  const candidates = []
  for (const block of source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(block[1])
  candidates.push(source)
  let best = null
  for (const candidate of candidates) {
    for (let start = candidate.indexOf('{'); start >= 0; start = candidate.indexOf('{', start + 1)) {
      const slice = balancedSlice(candidate, start)
      if (slice === null) continue
      let value
      try {
        value = JSON.parse(slice)
      } catch {
        continue
      }
      if (!isRecord(value)) continue
      // Prefer an object that looks like a memory draft, then the longest one.
      const shaped = Array.isArray(value.global) || isRecord(value.profile) || isRecord(value.sections)
      const score = (shaped ? 100000 : 0) + slice.length
      if (best === null || score > best.score) best = { value, score }
    }
  }
  return best === null ? null : best.value
}

/** The substring from `start` to its matching `}` (string-aware). */
function balancedSlice(source, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index++) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  return null
}

/* ------------------------- end consolidation ---------------------------- */


/* ------------------- /dream chat command (v2.9) ------------------------- */
/*
 * The chat-side trigger for consolidation: /dream generates a draft and reports
 * it in the conversation, /dream apply writes it, /dream discard drops it,
 * /dream status shows the chosen model and the last run. Writing still never
 * happens without the operator asking for it in a second step.
 */

function formatTokens(value) {
  return Number.isFinite(value) ? Number(value).toLocaleString('en-US') : '?'
}

function formatDelta(before, after) {
  const from = Number(before)
  const to = Number(after)
  const diff = to - from
  const percent = from > 0 ? `${diff === 0 ? '' : (diff > 0 ? '+' : '')}${((diff / from) * 100).toFixed(0)}%` : ''
  return `${formatTokens(from)} → ${formatTokens(to)} tokens${percent.length > 0 ? `（${percent}）` : ''}`
}

function dreamStatusText(config) {
  const provider = configString(config.consolidationProvider, '')
  const model = configString(config.consolidationModel, '')
  const effort = configString(config.consolidationReasoningEffort, '')
  const lines = [
    '记忆整理状态',
    provider.length === 0 || model.length === 0
      ? '整理模型：未选择（到 插件 → dsh-memory → 整理 里选择并保存，本插件不会自行挑选）'
      : `整理模型：${provider}/${model}${effort.length > 0 ? ` · 档位 ${effort}` : ' · 档位未指定（网关默认，实测更贵）'}`,
    `待处理建议稿：${consolidationDraft === null ? '无' : '有（等待 /dream apply 或 /dream discard）'}`,
  ]
  const history = loadConsolidationHistory(config)
  if (history.length === 0) {
    lines.push('整理历史：无记录')
  } else {
    lines.push(`整理历史（最近 ${Math.min(3, history.length)} / 共 ${history.length} 次，落盘 consolidation-log.json）：`)
    for (const row of history.slice(0, 3)) {
      const compression = Number.isFinite(row.beforeTokens) && Number.isFinite(row.afterTokens) && row.beforeTokens > 0
        ? ` · 注入 ${row.beforeTokens}→${row.afterTokens} tok（${(((row.afterTokens - row.beforeTokens) / row.beforeTokens) * 100).toFixed(0)}%）`
        : ''
      lines.push(
        `  ${new Date(row.at).toLocaleString()} · ${row.provider ?? '?'}/${row.model ?? '?'}${row.reasoningEffort ? ` · ${row.reasoningEffort}` : ''} · output ${formatTokens(row.outputTokens)} · ${(row.elapsedMs / 1000).toFixed(1)}s · ${row.ok ? '成功' : `失败(${row.code ?? 'error'})`}${compression}`,
      )
    }
  }
  return lines.join('\n')
}

function dreamDraftText(result) {
  const evaluation = result.evaluation
  const metrics = evaluation.metrics
  const usage = result.usage ?? {}
  const lines = [
    `记忆整理建议（${result.target.provider}/${result.target.model}${result.target.reasoningEffort === null ? '' : ` · 档位 ${result.target.reasoningEffort}`}）`,
    `用量：output ${formatTokens(usage.outputTokens)} tokens · 合计 ${formatTokens(usage.totalTokens)} · 耗时 ${(result.elapsedMs / 1000).toFixed(1)}s`,
    `画像：${formatDelta(metrics.before.profile.tokens, metrics.after.profile.tokens)}（要点 ${evaluation.counts.beforePoints} → ${evaluation.counts.afterPoints}）`,
    `索引：${formatDelta(metrics.before.index.tokens, metrics.after.index.tokens)}（条目 ${evaluation.counts.beforeEntries} → ${evaluation.counts.afterEntries}）`,
    `合计：${formatDelta(metrics.before.total.tokens, metrics.after.total.tokens)}`,
  ]
  if (evaluation.merged.length > 0) {
    lines.push(`合并：${evaluation.merged.map((entry) => `${entry.title}（并入 ${entry.from.length} 条）`).join('；')}`)
  }
  if (evaluation.removed.length > 0) {
    lines.push(`丢弃索引条目：${evaluation.removed.map((entry) => entry.title).join('；')}`)
  }
  lines.push(
    evaluation.lostCritical.length > 0
      ? `锚点校验：✗ 会丢失 ${evaluation.lostCritical.length} 个关键标识（${evaluation.lostCritical.slice(0, 6).join('、')}），无法应用`
      : '锚点校验：✓ 路径/URL/编号/数字均保留',
    evaluation.regression ? '⚠ 注入量未下降，无法应用' : '',
    '写入请发 /dream apply（会先快照），放弃请发 /dream discard。',
  )
  return lines.filter((line) => line.length > 0).join('\n')
}

async function dreamCommandHandler(commandCtx, config, invocation) {
  const arg = String(invocation?.rawInput ?? '').trim().toLowerCase()
  if (arg === 'status') return { kind: 'success', text: dreamStatusText(config) }
  if (arg === 'discard') {
    if (consolidationDraft === null) return { kind: 'error', text: '没有待处理的整理建议。' }
    consolidationDraft = null
    return { kind: 'success', text: '已丢弃待处理的整理建议，未写入任何数据。' }
  }
  if (arg === 'apply') {
    const pending = consolidationDraft
    if (pending === null) return { kind: 'error', text: '没有待处理的整理建议：先发 /dream 生成。' }
    const applied = await applyConsolidation(config, pending.token)
    if (applied.ok !== true) return { kind: 'error', text: `未能应用整理结果：${applied.message ?? applied.code}` }
    return {
      kind: 'success',
      text: [
        '已应用整理结果。',
        `快照：${applied.snapshot}`,
        `画像要点 ${applied.stats.profilePoints} 条 · 全局索引 ${applied.stats.globalEntries} 条`,
        `注入合计 ${formatTokens(applied.injection.total.tokens)} tokens（预算占用 ${(applied.injection.total.budgetShare * 100).toFixed(1)}%）`,
      ].join('\n'),
    }
  }
  if (arg.length > 0) {
    return { kind: 'error', text: `未知参数「${arg}」：可用 /dream、/dream apply、/dream discard、/dream status。` }
  }
  const result = await runConsolidation(commandCtx, config, {})
  if (result.ok !== true) return { kind: 'error', text: `未能生成整理建议：${result.message ?? result.code}` }
  return { kind: 'success', text: dreamDraftText(result) }
}

/** Register the /dream command; hosts without the commands service skip it. */
function setupDreamCommand(ctx, config) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(() => {
      const dispose = commandCtx.commands.register({
        definitionId: 'dsh-memory-dream',
        name: 'dream',
        description: '整理记忆：压缩用户画像与全局索引（/dream apply 写入、/dream discard 丢弃、/dream status 查看）',
        // A command that takes arguments MUST advertise an input descriptor:
        // the composer refuses to claim an argued line for a command that
        // declares none, and silently submits it as a normal message instead.
        input: { hint: 'apply | discard | status；留空则生成整理建议' },
        handler: (invocation) => dreamCommandHandler(commandCtx, config, invocation),
      })
      dreamCommandRegistered = true
      return () => {
        dreamCommandRegistered = false
        dispose()
      }
    }, 'dsh-memory: /dream command')
  })
}

/* ------------------------- end /dream ---------------------------------- */

/** Serve the editor bridge; absent web servers (headless) simply never inject. */
/** Short human label for the exported scope, used in the file name. */
function exportScopeLabel(options, material) {
  if (options.profile === false && material.sessions.length === 0) return 'empty'
  if (Array.isArray(options.sessionIds) && options.sessionIds.length > 0) return `sessions-${material.sessions.length}`
  if (typeof options.query === 'string' && options.query.trim().length > 0) return `query-${material.sessions.length}`
  if (typeof options.category === 'string' && options.category.length > 0) return `category-${material.sessions.length}`
  if (options.profile === false) return `sessions-${material.sessions.length}`
  return `all-${material.sessions.length}`
}

/**
 * Transfer bridge: export writes a bundle into `memory/transfer/`, import reads
 * only from there (no arbitrary paths), previews first, snapshots, then applies.
 */
function setupTransferBridge(ctx, config) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: TRANSFER_PATH,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          sendBridgeJson(res, 403, { ok: false, code: 'loopback-only', message: 'loopback requests only' })
          return
        }
        const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
        try {
          if (req.method === 'GET') {
            if (query.get('snapshots') !== null) {
              sendBridgeJson(res, 200, { ok: true, snapshots: await listBackupSnapshots(config) })
              return
            }
            const previewFile = query.get('preview')
            if (previewFile !== null) {
              const { fileName, text } = await readTransferFile(config, previewFile)
              const parsed = parseExportBundle(text)
              if (parsed.ok !== true) {
                sendBridgeJson(res, 200, { ok: false, file: fileName, ...parsed })
                return
              }
              const plan = planImport({
                bundle: parsed.bundle,
                targetProfile: await readProfile(config),
                targetSessionIds: new Set(await listSessionFiles(config)),
                onExisting: query.get('onExisting') ?? 'merge',
              })
              sendBridgeJson(res, 200, {
                ok: true,
                file: fileName,
                dir: transferDirOf(config),
                source: parsed.bundle.source,
                exportedAt: parsed.bundle.exportedAt,
                counts: parsed.bundle.counts,
                checksum: parsed.bundle.checksum,
                plan,
              })
              return
            }
            sendBridgeJson(res, 200, { ok: true, dir: transferDirOf(config), files: await listTransferFiles(config) })
            return
          }
          if (req.method !== 'POST') {
            sendBridgeJson(res, 405, { ok: false, code: 'method-not-allowed', message: `method not allowed: ${req.method ?? ''}` })
            return
          }
          const body = await readBridgeBody(req)
          if (body === undefined) {
            sendBridgeJson(res, 400, { ok: false, code: 'malformed-body', message: 'malformed JSON body' })
            return
          }
          const options = isRecord(body) ? body : {}

          if (query.get('export') !== null) {
            const material = await collectExportScope(config, options)
            const at = Date.now()
            const bundle = buildExportBundle({
              version: PLUGIN_VERSION,
              profile: material.profile,
              entries: material.entries,
              sessions: material.sessions,
              options: {
                profile: options.profile !== false,
                sessionIds: Array.isArray(options.sessionIds) ? options.sessionIds.map((id) => safeSessionId(id)) : null,
                category: typeof options.category === 'string' && options.category.length > 0 ? options.category : null,
                since: Number.isFinite(options.since) ? options.since : null,
                query: typeof options.query === 'string' && options.query.length > 0 ? options.query : null,
              },
              at,
            })
            const text = `${JSON.stringify(bundle, null, 2)}\n`
            const bytes = Buffer.byteLength(text, 'utf8')
            if (bytes > TRANSFER_MAX_BYTES) {
              sendBridgeJson(res, 200, { ok: false, code: 'too-large', message: `bundle would be ${bytes} bytes > ${TRANSFER_MAX_BYTES}` })
              return
            }
            const target = resolveExportTarget(config, options)
            const fileName = target.file ?? `memory-export-${new Date(at).toISOString().replace(/[:.]/g, '-')}-${exportScopeLabel(options, material)}.json`
            const fullPath = join(target.dir, fileName)
            if (existsSync(fullPath) && options.overwrite !== true) {
              sendBridgeJson(res, 200, { ok: false, code: 'dest-exists', path: fullPath, message: `${fullPath} 已存在；如需覆盖请传 overwrite: true` })
              return
            }
            await mkdir(target.dir, { recursive: true })
            await writeFile(fullPath, text, { mode: 0o600 })
            sendBridgeJson(res, 200, {
              ok: true,
              file: fileName,
              path: fullPath,
              dir: target.dir,
              inTransfer: resolve(target.dir) === resolve(transferDirOf(config)),
              revealed: options.reveal === true ? revealPath(fullPath) : false,
              bytes,
              counts: bundle.counts,
              checksum: bundle.checksum,
            })
            return
          }

          const importFile = query.get('import')
          if (importFile !== null) {
            if (options.confirm !== true) {
              sendBridgeJson(res, 200, { ok: false, code: 'confirm-required', message: '导入需显式确认（confirm: true）；先用 ?preview=<file> 查看将发生的改动' })
              return
            }
            const { fileName, text } = await readTransferFile(config, importFile)
            const parsed = parseExportBundle(text)
            if (parsed.ok !== true) {
              sendBridgeJson(res, 200, { ok: false, file: fileName, ...parsed })
              return
            }
            const result = await withGlobalLock(config, async () => {
              const plan = planImport({
                bundle: parsed.bundle,
                targetProfile: await readProfile(config),
                targetSessionIds: new Set(await listSessionFiles(config)),
                onExisting: typeof options.onExisting === 'string' ? options.onExisting : 'merge',
              })
              return applyImport(config, parsed.bundle, plan, options)
            })
            void scanSessionLinks(config).catch(() => {})
            sendBridgeJson(res, 200, { ok: true, file: fileName, ...result })
            return
          }

          const rollbackName = query.get('rollback')
          if (rollbackName !== null) {
            const result = await withGlobalLock(config, () => rollbackImportSnapshot(config, rollbackName))
            void scanSessionLinks(config).catch(() => {})
            sendBridgeJson(res, 200, result)
            return
          }

          sendBridgeJson(res, 400, {
            ok: false,
            code: 'bad-request',
            message: 'use ?export=1, ?import=<file>, ?rollback=<snapshot>, ?list=1 or ?preview=<file>',
          })
        } catch (error) {
          sendBridgeJson(res, 200, { ok: false, code: 'transfer-failed', message: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'dsh-memory: transfer bridge')
  })
}

function setupStoreBridge(ctx, config) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: CONSOLIDATE_PATH,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          sendBridgeJson(res, 403, { ok: false, code: 'loopback-only', message: 'loopback requests only' })
          return
        }
        if (req.method === 'GET') {
          const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
          // Troubleshooting: which slash commands one session's catalog carries.
          const commandsFor = query.get('commandsFor')
          if (commandsFor !== null) {
            const agentsService = typeof webCtx.get === 'function' ? webCtx.get('agents') : undefined
            const commandsService = typeof webCtx.get === 'function' ? webCtx.get('commands') : undefined
            const agent = typeof agentsService?.get === 'function' ? agentsService.get(commandsFor) : undefined
            const rows = agent === undefined || commandsService === undefined
              ? null
              : commandsService.list(agent).map((descriptor) => ({
                  name: descriptor.name,
                  hasInput: descriptor.input !== undefined,
                  hint: descriptor.input?.hint ?? null,
                }))
            sendBridgeJson(res, 200, { ok: true, sessionId: commandsFor, agentFound: agent !== undefined, commands: rows })
            return
          }
          const catalogFor = query.get('catalog')
          if (catalogFor !== null) {
            sendBridgeJson(res, 200, await consolidationCatalog(webCtx, catalogFor))
            return
          }
          const catalog = await consolidationCatalog(webCtx, null)
          sendBridgeJson(res, 200, {
            ok: true,
            draftPending: consolidationDraft !== null,
            commandRegistered: dreamCommandRegistered,
            lastRun: consolidationLastRun,
            history: loadConsolidationHistory(config).slice(0, 12),
            draftCreatedAt: consolidationDraft === null ? null : consolidationDraft.createdAt,
            providers: catalog.providers ?? [],
            configured: {
              provider: configString(config.consolidationProvider, ''),
              model: configString(config.consolidationModel, ''),
              reasoningEffort: configString(config.consolidationReasoningEffort, ''),
              maxTokens: Number.isFinite(Number(config.consolidationMaxTokens)) && Number(config.consolidationMaxTokens) > 0
                ? Math.floor(Number(config.consolidationMaxTokens))
                : CONSOLIDATION_DEFAULT_TOKENS,
            },
          })
          return
        }
        if (req.method !== 'POST') {
          sendBridgeJson(res, 405, { ok: false, code: 'method-not-allowed', message: `method not allowed: ${req.method ?? ''}` })
          return
        }
        const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
        const apply = query.get('apply')
        const discard = query.get('discard')
        if (apply !== null || discard !== null) {
          if (discard !== null) {
            consolidationDraft = null
            sendBridgeJson(res, 200, { ok: true, discarded: true })
            return
          }
          try {
            sendBridgeJson(res, 200, await applyConsolidation(config, apply))
          } catch (error) {
            sendBridgeJson(res, 500, { ok: false, code: 'write-failed', message: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        const body = await readBridgeBody(req)
        try {
          sendBridgeJson(res, 200, await runConsolidation(webCtx, config, body === undefined ? {} : body))
        } catch (error) {
          sendBridgeJson(res, 500, { ok: false, code: 'internal', message: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'dsh-memory: consolidation bridge')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: STORE_BRIDGE_PATH,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          sendBridgeJson(res, 403, { ok: false, code: 'loopback-only', message: 'loopback requests only' })
          return
        }
        if (req.method === 'GET') {
          const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
          if (query.get('sessionLinks') !== null || query.get('rescanLinks') !== null) {
            const scan = query.get('rescanLinks') !== null ? await scanSessionLinks(config) : (sessionLinkScan ?? await scanSessionLinks(config))
            sendBridgeJson(res, 200, { ok: true, sessionLinks: scan })
            return
          }
          if (query.get('doctor') !== null) {
            sendBridgeJson(res, 200, await auditMemoryLinks(config))
            return
          }
          // `?sessions=1` lists session files; `?session=<id>` returns one file's memories.
          if (query.get('sessions') !== null) {
            sendBridgeJson(res, 200, { ok: true, sessions: await listSessionSummaries(config) })
            return
          }
          const sessionFor = query.get('session')
          if (sessionFor !== null) {
            const detail = await readSessionDetail(config, sessionFor)
            sendBridgeJson(res, 200, detail === null ? { ok: false, code: 'no-session', message: `no session ${sessionFor}` } : { ok: true, ...detail })
            return
          }
          // `?limit=` / `?bytes=` price a hypothetical budget without writing it.
          const override = {}
          const limit = Number(query.get('limit'))
          const bytes = Number(query.get('bytes'))
          if (Number.isFinite(limit) && limit >= 1) override.injectLimit = Math.floor(limit)
          if (Number.isFinite(bytes) && bytes >= 1) override.maxInjectBytes = Math.floor(bytes)
          sendBridgeJson(res, 200, await readStoreView(config, override))
          return
        }
        if (req.method !== 'POST') {
          sendBridgeJson(res, 405, { ok: false, code: 'method-not-allowed', message: `method not allowed: ${req.method ?? ''}` })
          return
        }
        const body = await readBridgeBody(req)
        if (body === undefined) {
          sendBridgeJson(res, 400, { ok: false, code: 'malformed-body', message: 'malformed JSON body' })
          return
        }
        const ops = Array.isArray(body) ? body : body.ops
        if (!Array.isArray(ops)) {
          sendBridgeJson(res, 400, { ok: false, code: 'malformed-body', message: 'expected an ops array' })
          return
        }
        try {
          sendBridgeJson(res, 200, await applyStoreOps(webCtx, config, ops))
        } catch (error) {
          sendBridgeJson(res, 500, {
            ok: false,
            code: 'write-failed',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }), 'dsh-memory: store bridge')
  })
}

export function apply(ctx, config = {}) {
  noteMemoryRoot(config)
  // Legacy migration runs once when enabled.
  if (config.migration !== false) {
    migrateLegacyConfig(config).catch((err) => {
      // Migration must never crash the host; log and continue.
      try {
        // eslint-disable-next-line no-console
        console.error('[dsh-memory] legacy migration failed:', err)
      } catch {
        /* ignore */
      }
    })
  }
  // Auto backup on startup (v2.2): never crashes the host.
  maybeBackup(config).catch(() => {})
  setupTools(ctx, config)
  setupInjection(ctx, config)
  setupStoreBridge(ctx, config)
  setupTransferBridge(ctx, config)
  setupDreamCommand(ctx, config)
  // Link scan once per plugin load (imports, pruned logs, new forks all settle here).
  void scanSessionLinks(config).catch(() => {})
}
