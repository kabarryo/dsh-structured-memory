/**
 * dsh-structured-memory client half (v2.5): the memory store editor shown as this plugin's
 * row configuration on the Plugins page.
 *
 * Written in the module-loader format the browser half expects, so the bundle
 * needs no build step: `window.__ModuleLoader__.load({ id, factory })` with
 * `require` for the shared client packages. The row config slot is keyed by
 * `<package name>#<row id from cordis.patch.yml>` (see ui-plugin-manager's
 * rowConfigKey), i.e. "dsh-structured-memory#dsh-structured-memory".
 *
 * All reads and writes go to the plugin's own loopback bridge
 * (/api/dsh-structured-memory-store); memory JSON stays the single source of truth.
 */
window.__ModuleLoader__.load({
  id: 'dsh-structured-memory',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const react = require('react')
    const h = react.createElement

    const BRIDGE = '/api/dsh-structured-memory-store'
    const CONSOLIDATE = '/api/dsh-structured-memory-consolidate'
    const TRANSFER = '/api/dsh-structured-memory-transfer'
    const SECTIONS = [
      ['identity', '身份'],
      ['work', '工作'],
      ['personal', '个人'],
      ['technical', '技术'],
      ['style', '风格'],
    ]
    const STYLE_ID = 'dsh-structured-memory-config-style'

    const CSS = [
      '.dshmem{font-family:-apple-system,"SF Pro Text","PingFang SC",system-ui,sans-serif;font-size:13px;line-height:1.55;display:flex;flex-direction:column;gap:10px;color:inherit}',
      '.dshmem-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dshmem-tabs{display:flex;gap:6px}',
      '.dshmem-tab{cursor:pointer;border:1px solid rgba(127,127,127,.28);background:transparent;color:inherit;font:inherit;padding:4px 12px;border-radius:999px}',
      '.dshmem-tab[data-on="1"]{background:rgba(127,127,127,.16);border-color:rgba(127,127,127,.5);font-weight:600}',
      '.dshmem-sec{border:1px solid rgba(127,127,127,.2);border-radius:10px;padding:8px 10px;margin-bottom:8px}',
      '.dshmem-sec>header{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px}',
      '.dshmem-sec h4{margin:0;font-size:12px;letter-spacing:.04em;opacity:.75;text-transform:uppercase}',
      '.dshmem-row{display:flex;gap:8px;align-items:flex-start;margin-bottom:6px}',
      '.dshmem-row textarea,.dshmem-field input,.dshmem-field textarea{width:100%;box-sizing:border-box;font:inherit;color:inherit;background:rgba(127,127,127,.06);border:1px solid rgba(127,127,127,.28);border-radius:8px;padding:6px 8px;resize:vertical}',
      '.dshmem-entry{border:1px solid rgba(127,127,127,.2);border-radius:10px;padding:8px 10px;margin-bottom:8px;display:flex;flex-direction:column;gap:6px}',
      '.dshmem-field{display:flex;gap:8px;align-items:baseline}',
      '.dshmem-field>label{flex:0 0 44px;opacity:.65}',
      '.dshmem-meta{opacity:.6}',
      '.dshmem-btn{cursor:pointer;font:inherit;color:inherit;background:transparent;border:1px solid rgba(127,127,127,.32);border-radius:8px;padding:3px 10px}',
      '.dshmem-btn:disabled{opacity:.45;cursor:default}',
      '.dshmem-btn.primary{background:rgba(127,127,127,.16);font-weight:600}',
      '.dshmem-del{color:#c0392b;border-color:rgba(192,57,43,.35)}',
      '.dshmem-err{color:#c0392b}',
      '.dshmem-ok{opacity:.7}',
      '.dshmem-empty{opacity:.55;padding:6px 0}',
      '.dshmem-tbl{width:100%;border-collapse:collapse;margin:6px 0}',
      '.dshmem-tbl th,.dshmem-tbl td{text-align:right;padding:3px 6px;border-bottom:1px solid rgba(127,127,127,.16);font-variant-numeric:tabular-nums}',
      '.dshmem-tbl th:first-child,.dshmem-tbl td:first-child{text-align:left}',
      '.dshmem-tbl th{font-weight:600;opacity:.62;font-size:11px;letter-spacing:.04em}',
      '.dshmem-num{width:120px;font:inherit;color:inherit;background:rgba(127,127,127,.06);border:1px solid rgba(127,127,127,.28);border-radius:8px;padding:4px 8px}',
      '.dshmem-warn{color:#b7791f}',
      '.dshmem-split{display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap}',
      '.dshmem-list{flex:1 1 320px;min-width:260px;max-height:min(52vh,420px);overflow:auto;border:1px solid rgba(127,127,127,.2);border-radius:10px;padding:6px}',
      '.dshmem-detail{flex:1 1 380px;min-width:280px;max-height:min(60vh,520px);overflow:auto}',
      '.dshmem-row.sel{background:rgba(127,127,127,.14);border-radius:8px}',
      '.dshmem-row{border:1px solid transparent}',
      '.dshmem-hit{border:1px solid rgba(127,127,127,.55);background:rgba(127,127,127,.14)}',
    ].join('\n')

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS
      document.head.appendChild(el)
    }

/** Rough export size estimate. Measured JSON/正文 ratio is about 1.33. */
const EXPORT_BYTES_PER_CONTENT = 1.33
const EXPORT_OVERHEAD_BYTES = 2048

function estimateExport(sessionRows, pickedIds, includeProfile, profilePoints) {
  const rows = Array.isArray(sessionRows) ? sessionRows : []
  const wanted = Array.isArray(pickedIds) && pickedIds.length > 0 ? new Set(pickedIds) : null
  const picked = wanted === null ? rows : rows.filter((row) => wanted.has(row.sessionId))
  const memories = picked.reduce((total, row) => total + (Number(row.count) || 0), 0)
  const content = picked.reduce((total, row) => total + (Number(row.bytes) || 0), 0)
  const profileBytes = includeProfile === true ? (Number(profilePoints) || 0) * 240 : 0
  return {
    sessions: picked.length,
    memories,
    contentBytes: content,
    estimateBytes: Math.round((content + profileBytes) * EXPORT_BYTES_PER_CONTENT + EXPORT_OVERHEAD_BYTES),
  }
}

/** Human lines for an import preview report. */
function describeImportPlan(plan) {
  if (plan === null || typeof plan !== 'object') return []
  const list = (value) => (Array.isArray(value) ? value : [])
  const sessions = list(plan.sessions)
  const byMode = (mode) => sessions.filter((row) => row.mode === mode).length
  const lines = [
    `画像：新增 ${list(plan.profileAdds).length} · 跳过 ${list(plan.profileSkips).length}`,
    `会话：新建 ${byMode('create')} · 合并 ${byMode('merge')} · 跳过 ${byMode('skip')} · 替换 ${byMode('replace')}`,
    `将补建索引条目 ${list(plan.entriesToBuild).length} 个`,
  ]
  const rejected = list(plan.rejectedEntries)
  if (rejected.length > 0) {
    lines.push(`拒绝的孤儿条目 ${rejected.length} 个（${rejected.map((entry) => entry.title || entry.id).join('、')}）`)
  }
  return lines
}

/** Client-side pre-check for a destination path (the server enforces the rule). */
function destHint(value) {
  const text = String(value ?? '').trim()
  if (text.length === 0) return ''
  if (!text.startsWith('/') && !text.startsWith('~')) return '路径需为绝对路径（以 / 或 ~ 开头）'
  if (!text.endsWith('.json')) return '文件名需以 .json 结尾'
  return '服务端还会校验：须位于家目录或 /tmp 内，且默认不覆盖已存在文件'
}

    async function api(method, body, query, base) {
      const init = { method }
      if (body !== undefined) {
        init.headers = { 'content-type': 'application/json' }
        init.body = JSON.stringify(body)
      }
      const res = await fetch((base || BRIDGE) + (query || ''), init)
      let data = null
      try {
        data = await res.json()
      } catch {
        data = null
      }
      if (data === null) throw new Error(`HTTP ${res.status}`)
      return data
    }

    function draftOf(view) {
      const sections = {}
      for (const [key] of SECTIONS) {
        sections[key] = Array.isArray(view.profile.sections[key]) ? view.profile.sections[key].slice() : []
      }
      return {
        sections,
        global: view.global.map((entry) => ({
          id: entry.id,
          sessionId: entry.sessionId,
          title: entry.title,
          keyPoints: entry.keyPoints,
          category: entry.category,
        })),
      }
    }

    function MemoryPage() {
      const [state, setState] = react.useState({ phase: 'loading' })
      const [draft, setDraft] = react.useState(null)
      const [removed, setRemoved] = react.useState([])
      const [tab, setTab] = react.useState('profile')
      const [injectCfg, setInjectCfg] = react.useState({ injectLimit: 20, maxInjectBytes: 8192 })
      const [injection, setInjection] = react.useState(null)
      const [previewing, setPreviewing] = react.useState(false)
      const [cfgStatus, setCfgStatus] = react.useState('')
      const [tidyDraft, setTidyDraft] = react.useState(null)
      const [tidyStatus, setTidyStatus] = react.useState('')
      const [tidyBusy, setTidyBusy] = react.useState(false)
      const [lastRun, setLastRun] = react.useState(null)
      const [providers, setProviders] = react.useState([])
      const [catalogModels, setCatalogModels] = react.useState([])
      const [modelCfg, setModelCfg] = react.useState({ provider: '', model: '', reasoningEffort: '' })
      const [modelStatus, setModelStatus] = react.useState('')
      const [savedCfg, setSavedCfg] = react.useState({ provider: '', model: '', reasoningEffort: '' })
      const [commandReady, setCommandReady] = react.useState(false)
      const [history, setHistory] = react.useState([])
      const [sessionList, setSessionList] = react.useState(null)
      const [sessionDetail, setSessionDetail] = react.useState(null)
      const [memoryRemovals, setMemoryRemovals] = react.useState([])
      const [sessionRemovals, setSessionRemovals] = react.useState([])
      const [sessionStatus, setSessionStatus] = react.useState('')
      const [sessionDraft, setSessionDraft] = react.useState(null)
      const [sessionDraftStatus, setSessionDraftStatus] = react.useState('')
      const [dreamBusy, setDreamBusy] = react.useState(false)
      const [rewriteDraft, setRewriteDraft] = react.useState(null)
      const [rewriteKeyPoint, setRewriteKeyPoint] = react.useState('')
      const [rewriteArm, setRewriteArm] = react.useState(false)
      const [transferFiles, setTransferFiles] = react.useState(null)
      const [snapshots, setSnapshots] = react.useState(null)
      const [transferNote, setTransferNote] = react.useState('')
      const [transferBusy, setTransferBusy] = react.useState(false)
      const [exportCfg, setExportCfg] = react.useState({ scope: 'all', picked: [], profile: true, query: '', destMode: 'transfer', dest: '', overwrite: false, reveal: true })
      const [exportResult, setExportResult] = react.useState(null)
      const [importPick, setImportPick] = react.useState({ mode: 'transfer', file: '', path: '' })
      const [importCfg, setImportCfg] = react.useState({ onExisting: 'merge', remapSessions: false, replaceProfile: false })
      const [importPlan, setImportPlan] = react.useState(null)
      const [importArm, setImportArm] = react.useState(false)
      const [importResult, setImportResult] = react.useState(null)

      const [audit, setAudit] = react.useState(null)
      const [auditBusy, setAuditBusy] = react.useState(false)
      const [auditNote, setAuditNote] = react.useState('')
      const [status, setStatus] = react.useState('')
      const [busy, setBusy] = react.useState(false)

      const load = react.useCallback(async () => {
        try {
          const view = await api('GET')
          if (view.ok !== true) throw new Error(view.message || 'unavailable')
          setState({ phase: 'ready', view })
          setDraft(draftOf(view))
          setRemoved([])
          setStatus('')
          setInjectCfg({ injectLimit: view.limits.injectLimit, maxInjectBytes: view.limits.maxInjectBytes })
          setInjection(view.injection)
          setCfgStatus('')
        } catch (error) {
          setState({ phase: 'error', error: String((error && error.message) || error) })
        }
      }, [])

      react.useEffect(() => {
        ensureStyle()
        void load()
        api('GET', undefined, undefined, CONSOLIDATE)
          .then((status) => {
            if (status === null || status.ok !== true) return
            setLastRun(status.lastRun ?? null)
            setCommandReady(status.commandRegistered === true)
            setHistory(Array.isArray(status.history) ? status.history : [])
            setProviders(status.providers ?? [])
            const current = {
              provider: status.configured?.provider ?? '',
              model: status.configured?.model ?? '',
              reasoningEffort: status.configured?.reasoningEffort ?? '',
            }
            setModelCfg(current)
            setSavedCfg(current)
            if (current.provider.length > 0) void loadCatalog(current.provider, current.model)
          })
          .catch(() => {})
      }, [load])

      const patchSection = (key, points) =>
        setDraft((current) => ({ ...current, sections: { ...current.sections, [key]: points } }))

      const patchEntry = (id, field, value) =>
        setDraft((current) => ({
          ...current,
          global: current.global.map((entry) => (entry.id === id ? { ...entry, [field]: value } : entry)),
        }))

      const removeEntry = (id) => {
        setDraft((current) => ({ ...current, global: current.global.filter((entry) => entry.id !== id) }))
        setRemoved((current) => (current.includes(id) ? current : [...current, id]))
      }

      function buildOps() {
        const view = state.view
        const ops = []
        for (const [key] of SECTIONS) {
          const before = view.profile.sections[key] || []
          const after = draft.sections[key] || []
          if (JSON.stringify(before) !== JSON.stringify(after)) {
            ops.push({ op: 'profile.replace', section: key, points: after })
          }
        }
        for (const entry of draft.global) {
          const before = view.global.find((candidate) => candidate.id === entry.id)
          if (before === undefined) continue
          if (before.title !== entry.title || before.keyPoints !== entry.keyPoints || before.category !== entry.category) {
            ops.push({
              op: 'global.update',
              id: entry.id,
              title: entry.title,
              keyPoints: entry.keyPoints,
              category: entry.category,
            })
          }
        }
        for (const id of removed) ops.push({ op: 'global.remove', id })
        for (const row of memoryRemovals) ops.push({ op: 'memory.remove', sessionId: row.sessionId, memoryId: row.memoryId })
        for (const sessionId of sessionRemovals) ops.push({ op: 'session.remove', sessionId })
        return ops
      }

      const metrics = injection !== null ? injection : (state.view === undefined ? null : state.view.injection)

      async function previewConfig() {
        setPreviewing(true)
        setCfgStatus('预览中…')
        try {
          const query = `?limit=${encodeURIComponent(injectCfg.injectLimit)}&bytes=${encodeURIComponent(injectCfg.maxInjectBytes)}`
          const view = await api('GET', undefined, query)
          if (view.ok !== true) {
            setCfgStatus(`预览失败：${view.message || view.code}`)
            return
          }
          setInjection(view.injection)
          setCfgStatus('预览（未保存）')
        } catch (error) {
          setCfgStatus(`预览失败：${String((error && error.message) || error)}`)
        } finally {
          setPreviewing(false)
        }
      }

      async function saveConfig() {
        const view = state.view
        const ops = []
        if (injectCfg.injectLimit !== view.limits.injectLimit) {
          ops.push({ op: 'config.set', field: 'injectLimit', value: Number(injectCfg.injectLimit) })
        }
        if (injectCfg.maxInjectBytes !== view.limits.maxInjectBytes) {
          ops.push({ op: 'config.set', field: 'maxInjectBytes', value: Number(injectCfg.maxInjectBytes) })
        }
        if (ops.length === 0) {
          setCfgStatus('配置无改动')
          return
        }
        setPreviewing(true)
        setCfgStatus('写入 profile patch…')
        try {
          const next = await api('POST', { ops })
          if (next.ok !== true) {
            setCfgStatus(`已拒绝：${next.message || next.code}`)
            return
          }
          setState({ phase: 'ready', view: next })
          setDraft(draftOf(next))
          setRemoved([])
          setInjectCfg({ injectLimit: next.limits.injectLimit, maxInjectBytes: next.limits.maxInjectBytes })
          setInjection(next.injection)
          setCfgStatus('已写入 profile patch（即时生效）')
        } catch (error) {
          setCfgStatus(`写入失败：${String((error && error.message) || error)}`)
        } finally {
          setPreviewing(false)
        }
      }

      async function loadCatalog(provider, keepModel) {
        if (typeof provider !== 'string' || provider.length === 0) {
          setCatalogModels([])
          return
        }
        setModelStatus('正在读取该路由的模型目录…')
        try {
          const catalog = await api('GET', undefined, `?catalog=${encodeURIComponent(provider)}`, CONSOLIDATE)
          if (catalog.ok !== true) {
            setCatalogModels([])
            setModelStatus(`目录读取失败：${catalog.message || catalog.code}`)
            return
          }
          setCatalogModels(catalog.models ?? [])
          setModelStatus(`该路由共 ${(catalog.models ?? []).length} 个模型`)
          if (typeof keepModel === 'string' && keepModel.length > 0) {
            const hit = (catalog.models ?? []).find((entry) => entry.id === keepModel)
            if (hit !== undefined) setModelCfg((current) => ({ ...current, reasoningEffort: hit.efforts.some((e) => e.id === current.reasoningEffort) ? current.reasoningEffort : '' }))
          }
        } catch (error) {
          setModelStatus(`目录读取失败：${String((error && error.message) || error)}`)
        }
      }

      async function saveModel() {
        setTidyBusy(true)
        setModelStatus('正在写入 profile patch…')
        try {
          const ops = []
          if (modelCfg.provider !== savedCfg.provider) ops.push({ op: 'config.set', field: 'consolidationProvider', value: modelCfg.provider })
          if (modelCfg.model !== savedCfg.model) ops.push({ op: 'config.set', field: 'consolidationModel', value: modelCfg.model })
          if (modelCfg.reasoningEffort !== savedCfg.reasoningEffort) ops.push({ op: 'config.set', field: 'consolidationReasoningEffort', value: modelCfg.reasoningEffort })
          if (ops.length === 0) {
            setModelStatus('模型选择无改动')
            return
          }
          const next = await api('POST', { ops })
          if (next.ok !== true) {
            setModelStatus(`写入被拒：${next.message || next.code}`)
            return
          }
          setState({ phase: 'ready', view: next })
          setDraft(draftOf(next))
          const applied = { provider: modelCfg.provider, model: modelCfg.model, reasoningEffort: modelCfg.reasoningEffort }
          setSavedCfg(applied)
          setModelStatus('已保存（后续整理都用这个模型）')
        } catch (error) {
          setModelStatus(`写入失败：${String((error && error.message) || error)}`)
        } finally {
          setTidyBusy(false)
        }
      }

      async function loadSessions() {
        setSessionStatus('读取会话列表…')
        try {
          const result = await api('GET', undefined, '?sessions=1')
          if (result.ok !== true) {
            setSessionStatus(`读取失败：${result.message || result.code}`)
            return
          }
          setSessionList(result.sessions ?? [])
          setSessionStatus(`共 ${(result.sessions ?? []).length} 个会话记忆文件`)
        } catch (error) {
          setSessionStatus(`读取失败：${String((error && error.message) || error)}`)
        }
      }

      async function loadSession(sessionId) {
        setSessionStatus(`读取 ${sessionId} …`)
        try {
          const result = await api('GET', undefined, `?session=${encodeURIComponent(sessionId)}`)
          if (result.ok !== true) {
            setSessionDetail(null)
            setSessionStatus(`读取失败：${result.message || result.code}`)
            return
          }
          setSessionDetail(result)
          setSessionStatus(`${result.memories.length} 条记忆`)
        } catch (error) {
          setSessionStatus(`读取失败：${String((error && error.message) || error)}`)
        }
      }

      function queueMemoryRemoval(sessionId, memoryId) {
        setMemoryRemovals((current) => (current.some((row) => row.memoryId === memoryId) ? current : [...current, { sessionId, memoryId }]))
      }

      function queueSessionRemoval(sessionId) {
        setSessionRemovals((current) => (current.includes(sessionId) ? current : [...current, sessionId]))
      }

      async function makeSessionDraft(sessionId) {
        setDreamBusy(true)
        setSessionDraftStatus('正在调用模型整理该会话…')
        try {
          const result = await api('POST', { scope: 'session', sessionId }, undefined, CONSOLIDATE)
          if (result.ok !== true) {
            setSessionDraft(null)
            setSessionDraftStatus(`未生成：${result.message || result.code}`)
            return
          }
          setSessionDraft(result)
          setSessionDraftStatus(`已生成建议（output ${result.usage?.outputTokens ?? '?'} tokens · ${(result.elapsedMs / 1000).toFixed(1)}s）`)
        } catch (error) {
          setSessionDraftStatus(`调用失败：${String((error && error.message) || error)}`)
        } finally {
          setDreamBusy(false)
        }
      }

      async function applySessionDraft() {
        if (sessionDraft === null) return
        setDreamBusy(true)
        setSessionDraftStatus('正在应用…')
        try {
          const next = await api('POST', undefined, `?apply=${encodeURIComponent(sessionDraft.token)}`, CONSOLIDATE)
          if (next.ok !== true) {
            setSessionDraftStatus(`未应用：${next.message || next.code}`)
            return
          }
          setSessionDraftStatus(`已应用；原文件快照于 ${next.snapshot}`)
          setSessionDraft(null)
          void loadSessions()
          if (sessionDetail !== null) void loadSession(sessionDetail.sessionId)
        } catch (error) {
          setSessionDraftStatus(`应用失败：${String((error && error.message) || error)}`)
        } finally {
          setDreamBusy(false)
        }
      }

      async function discardSessionDraft() {
        if (sessionDraft === null) return
        try {
          await api('POST', undefined, `?discard=${encodeURIComponent(sessionDraft.token)}`, CONSOLIDATE)
        } catch {
          /* discarding is best effort */
        }
        setSessionDraft(null)
        setSessionDraftStatus('已丢弃建议')
      }

      async function runAudit() {
        setAuditBusy(true)
        setAuditNote('正在校验…')
        try {
          const result = await api('GET', undefined, '?doctor=1')
          setAudit(result)
          const multi = result.multiMemorySessions?.length ?? 0
          const attrs = result.attributeMismatches?.length ?? 0
          const problems = (result.missingEntries?.length ?? 0) + (result.orphanEntries?.length ?? 0) + (result.emptySessions?.length ?? 0) + (result.duplicateEntries?.length ?? 0) + multi + attrs
          setAuditNote(problems === 0
            ? `一致：${result.counts.sessions} 个会话 ↔ ${result.counts.entries} 条索引，且每会话恰好 1 条记忆`
            : `发现 ${problems} 处不一致：缺条目 ${result.missingEntries.length}、孤儿条目 ${result.orphanEntries.length}、空会话 ${result.emptySessions.length}、重复条目 ${result.duplicateEntries.length}、多记忆会话 ${multi}、标题/分类分歧 ${attrs}`)
        } catch (error) {
          setAuditNote(`校验失败：${String((error && error.message) || error)}`)
        } finally {
          setAuditBusy(false)
        }
      }

      async function repairLinks() {
        setAuditBusy(true)
        try {
          const result = await api('POST', { ops: [{ op: 'doctor.repair' }] })
          if (result.ok !== true) {
            setAuditNote(`修复被拒：${result.message || result.code}`)
            return
          }
          setState({ phase: 'ready', view: result })
          setDraft(draftOf(result))
          setAuditNote((result.actions ?? []).length === 0 ? '无需修复' : `已修复 ${result.actions.length} 处：${result.actions.join('；')}`)
          void runAudit()
        } catch (error) {
          setAuditNote(`修复失败：${String((error && error.message) || error)}`)
        } finally {
          setAuditBusy(false)
        }
      }

      async function loadTransfer() {
        setTransferBusy(true)
        setTransferNote('读取交换目录…')
        try {
          const [files, snaps] = await Promise.all([
            api('GET', undefined, '?list=1', TRANSFER),
            api('GET', undefined, '?snapshots=1', TRANSFER),
          ])
          const rows = files.ok === true ? (files.files ?? []) : []
          const snapRows = snaps.ok === true ? (snaps.snapshots ?? []) : []
          setTransferFiles(rows)
          setSnapshots(snapRows)
          setTransferNote(`${rows.length} 个 bundle · ${snapRows.length} 个快照 · ${files.dir ?? ''}`)
        } catch (error) {
          setTransferNote(`读取失败：${String((error && error.message) || error)}`)
        } finally {
          setTransferBusy(false)
        }
      }

      async function runExport() {
        setTransferBusy(true)
        setTransferNote('导出中…')
        setExportResult(null)
        try {
          const body = { profile: exportCfg.profile }
          if (exportCfg.scope === 'sessions' && exportCfg.picked.length > 0) body.sessionIds = exportCfg.picked
          if (exportCfg.query.trim().length > 0) body.query = exportCfg.query.trim()
          if (exportCfg.destMode === 'custom' && exportCfg.dest.trim().length > 0) body.dest = exportCfg.dest.trim()
          if (exportCfg.overwrite) body.overwrite = true
          if (exportCfg.reveal) body.reveal = true
          const result = await api('POST', body, '?export=1', TRANSFER)
          if (result.ok !== true) {
            setTransferNote(`导出失败：${result.message || result.code}`)
            return
          }
          setExportResult(result)
          setTransferNote(`已导出 ${result.file}`)
          void loadTransfer()
        } catch (error) {
          setTransferNote(`导出失败：${String((error && error.message) || error)}`)
        } finally {
          setTransferBusy(false)
        }
      }

      function importSpec() {
        return importPick.mode === 'transfer' ? importPick.file : importPick.path.trim()
      }

      async function checkImport() {
        const spec = importSpec()
        if (spec.length === 0) {
          setTransferNote('请先选择或填写要导入的 bundle')
          return
        }
        setTransferBusy(true)
        setTransferNote('检查中…')
        setImportPlan(null)
        setImportArm(false)
        setImportResult(null)
        try {
          const result = await api('GET', undefined, `?preview=${encodeURIComponent(spec)}&onExisting=${importCfg.onExisting}`, TRANSFER)
          if (result.ok !== true) {
            setTransferNote(`检查失败：${result.message || result.code}`)
            return
          }
          setImportPlan(result)
          setTransferNote('检查通过（未写入任何数据）')
        } catch (error) {
          setTransferNote(`检查失败：${String((error && error.message) || error)}`)
        } finally {
          setTransferBusy(false)
        }
      }

      async function runImport() {
        if (importPlan === null) return
        if (!importArm) {
          setImportArm(true)
          setTransferNote('再点一次以确认写入（写入前会自动快照）')
          return
        }
        const spec = importSpec()
        setTransferBusy(true)
        setTransferNote('导入中…')
        try {
          const result = await api('POST', {
            confirm: true,
            onExisting: importCfg.onExisting,
            remapSessions: importCfg.remapSessions,
            replaceProfile: importCfg.replaceProfile,
          }, `?import=${encodeURIComponent(spec)}`, TRANSFER)
          if (result.ok !== true) {
            setTransferNote(`导入失败：${result.message || result.code}`)
            setImportArm(false)
            return
          }
          setImportResult(result)
          setImportPlan(null)
          setImportArm(false)
          setTransferNote(`导入完成 · 快照 ${result.snapshot}`)
          void load()
          void loadSessions()
          void loadTransfer()
        } catch (error) {
          setTransferNote(`导入失败：${String((error && error.message) || error)}`)
        } finally {
          setTransferBusy(false)
        }
      }

      async function rollbackTransfer(snapshot) {
        setTransferBusy(true)
        setTransferNote(`回滚 ${snapshot} …`)
        try {
          const result = await api('POST', {}, `?rollback=${encodeURIComponent(snapshot)}`, TRANSFER)
          setTransferNote(result.ok === true
            ? `已回滚：还原 ${result.restored.length} 个文件 · 删除 ${result.removed.length} 个`
            : `回滚失败：${result.message || result.code}`)
          void load()
          void loadSessions()
          void loadTransfer()
        } catch (error) {
          setTransferNote(`回滚失败：${String((error && error.message) || error)}`)
        } finally {
          setTransferBusy(false)
        }
      }

      async function submitRewrite(sessionId) {
        if (rewriteDraft === null) return
        if (!rewriteArm) {
          setRewriteArm(true)
          setSessionDraftStatus('再点一次以确认重写这一条（会先快照吗：不会，重写前请自行确认内容）')
          return
        }
        setDreamBusy(true)
        setSessionDraftStatus('正在重写…')
        try {
          const result = await api('POST', {
            ops: [{ op: 'memory.replace', sessionId, content: rewriteDraft, keyPoint: rewriteKeyPoint.trim().length > 0 ? rewriteKeyPoint.trim() : undefined }],
          })
          if (result.ok !== true) {
            setSessionDraftStatus(`重写被拒：${result.message || result.code}`)
            setRewriteArm(false)
            return
          }
          setState({ phase: 'ready', view: result })
          setDraft(draftOf(result))
          setSessionDraftStatus((result.actions ?? []).join('；') || '已重写')
          setRewriteDraft(null)
          setRewriteKeyPoint('')
          setRewriteArm(false)
          void loadSessions()
          void loadSession(sessionId)
        } catch (error) {
          setSessionDraftStatus(`重写失败：${String((error && error.message) || error)}`)
        } finally {
          setDreamBusy(false)
        }
      }

      async function makeDraft() {
        setTidyBusy(true)
        setTidyStatus('正在调用模型生成建议…')
        try {
          const result = await api('POST', {}, undefined, CONSOLIDATE)
          if (result.ok !== true) {
            setTidyDraft(null)
            setTidyStatus(`未生成：${result.message || result.code}`)
            return
          }
          setTidyDraft(result)
          const u = result.usage
          const cost = u === null || u === undefined
            ? ''
            : `；本次消耗 input ${u.inputTokens} / output ${u.outputTokens} tokens，缓存读入 ${u.cacheReadTokens ?? 0}，耗时 ${(result.elapsedMs / 1000).toFixed(1)}s`
          setTidyStatus(`已生成建议（模型 ${result.target.provider}/${result.target.model}，来源 ${result.target.source}）${cost}`)
        } catch (error) {
          setTidyStatus(`调用失败：${String((error && error.message) || error)}`)
        } finally {
          setTidyBusy(false)
        }
      }

      async function applyDraft() {
        if (tidyDraft === null) return
        setTidyBusy(true)
        setTidyStatus('正在应用…')
        try {
          const next = await api('POST', undefined, `?apply=${encodeURIComponent(tidyDraft.token)}`, CONSOLIDATE)
          if (next.ok !== true) {
            setTidyStatus(`未应用：${next.message || next.code}`)
            return
          }
          setState({ phase: 'ready', view: next })
          setTidyDraft(draftOf(next))
          setRemoved([])
          setInjectCfg({ injectLimit: next.limits.injectLimit, maxInjectBytes: next.limits.maxInjectBytes })
          setInjection(next.injection)
          setTidyDraft(null)
          setTidyStatus(`已应用；原文件快照于 ${next.snapshot}`)
        } catch (error) {
          setTidyStatus(`应用失败：${String((error && error.message) || error)}`)
        } finally {
          setTidyBusy(false)
        }
      }

      async function discardDraft() {
        if (tidyDraft === null) return
        try {
          await api('POST', undefined, `?discard=${encodeURIComponent(tidyDraft.token)}`, CONSOLIDATE)
        } catch {
          /* discarding is best effort */
        }
        setTidyDraft(null)
        setTidyStatus('已丢弃建议')
      }

      async function save() {
        const ops = buildOps()
        if (ops.length === 0) {
          setStatus('没有改动')
          return
        }
        setBusy(true)
        setStatus('保存中…')
        try {
          const view = await api('POST', { ops })
          if (view.ok !== true) {
            setStatus(`已拒绝：${view.message || view.code}`)
            return
          }
          setState({ phase: 'ready', view })
          setDraft(draftOf(view))
          setRemoved([])
          const touched = memoryRemovals.length + sessionRemovals.length
          setMemoryRemovals([])
          setSessionRemovals([])
          setStatus(`已保存（${view.changed} 处改动${touched > 0 ? `，含 ${touched} 处会话记忆删除` : ''}）`)
          if (touched > 0) {
            void loadSessions()
            if (sessionDetail !== null) void loadSession(sessionDetail.sessionId)
          }
        } catch (error) {
          setStatus(`失败：${String((error && error.message) || error)}`)
        } finally {
          setBusy(false)
        }
      }

      if (state.phase === 'loading') return h('div', { className: 'dshmem' }, '正在读取记忆库…')
      if (state.phase === 'error') {
        return h('div', { className: 'dshmem' }, h('div', { className: 'dshmem-err' }, `读取失败：${state.error}`))
      }

      const view = state.view
      const dirty = buildOps().length > 0
      const info = h(
        'span',
        { className: 'dshmem-meta' },
        `画像 ${view.stats.profilePoints} 点 · 全局索引 ${view.stats.globalEntries} 条 · 注入上限 ${view.limits.injectLimit}`,
      )

      const header = h(
        'div',
        { className: 'dshmem-bar' },
        h('div', { className: 'dshmem-tabs' }, [
          h('button', { key: 'p', className: 'dshmem-tab', 'data-on': tab === 'profile' ? '1' : '0', onClick: () => setTab('profile') }, '用户画像'),
          h('button', { key: 'g', className: 'dshmem-tab', 'data-on': tab === 'global' ? '1' : '0', onClick: () => setTab('global') }, '全局索引'),
          h('button', { key: 'i', className: 'dshmem-tab', 'data-on': tab === 'inject' ? '1' : '0', onClick: () => setTab('inject') }, '注入控制'),
          h('button', { key: 't', className: 'dshmem-tab', 'data-on': tab === 'tidy' ? '1' : '0', onClick: () => setTab('tidy') }, '整理'),
          h(
            'button',
            {
              key: 's',
              className: 'dshmem-tab',
              'data-on': tab === 'sessions' ? '1' : '0',
              onClick: () => {
                setTab('sessions')
                if (sessionList === null) void loadSessions()
              },
            },
            '会话记忆',
          ),
          h(
            'button',
            {
              key: 'd',
              className: 'dshmem-tab',
              'data-on': tab === 'transfer' ? '1' : '0',
              onClick: () => {
                setTab('transfer')
                if (transferFiles === null) void loadTransfer()
                if (sessionList === null) void loadSessions()
              },
            },
            '数据',
          ),
        ]),
        info,
        h('span', { style: { flex: 1 } }),
        h('button', { className: 'dshmem-btn', onClick: () => void load(), disabled: busy }, '重新载入'),
      )

      const profileBody = h(
        'div',
        null,
        SECTIONS.map(([key, label]) => {
          const points = draft.sections[key] || []
          return h(
            'section',
            { className: 'dshmem-sec', key },
            h(
              'header',
              null,
              h('h4', null, `${label} · ${points.length}`),
              h(
                'button',
                { className: 'dshmem-btn', onClick: () => patchSection(key, [...points, '']) },
                '＋ 新增要点',
              ),
            ),
            points.length === 0
              ? h('div', { className: 'dshmem-empty' }, '（空）')
              : points.map((point, index) =>
                  h(
                    'div',
                    { className: 'dshmem-row', key: `${key}-${index}` },
                    h('textarea', {
                      value: point,
                      rows: Math.min(6, Math.max(1, Math.ceil(point.length / 90))),
                      onChange: (event) => {
                        const next = points.slice()
                        next[index] = event.target.value
                        patchSection(key, next)
                      },
                    }),
                    h(
                      'button',
                      {
                        className: 'dshmem-btn dshmem-del',
                        title: '删除该要点',
                        onClick: () => patchSection(key, points.filter((_, i) => i !== index)),
                      },
                      '删除',
                    ),
                  ),
                ),
          )
        }),
      )

      const globalBody = h(
        'div',
        null,
        h(
          'section',
          { className: 'dshmem-sec' },
          h('header', null, h('h4', null, '索引 ↔ 会话记忆关联'), h('span', { className: 'dshmem-meta' }, auditNote)),
          h(
            'div',
            { className: 'dshmem-bar' },
            h('button', { className: 'dshmem-btn', onClick: () => void runAudit(), disabled: auditBusy }, '校验关联'),
            h('button', { className: 'dshmem-btn', onClick: () => void repairLinks(), disabled: auditBusy }, '修复不一致'),
            h('span', { className: 'dshmem-meta' }, '约定：每个会话记忆文件恰好对应一条索引条目，且**每会话只保留 1 条记忆**（保存只改写这一条）；条目不可单独删除，删整会话会一并删除条目'),
          ),
          audit === null
            ? null
            : h(
                'div',
                { className: 'dshmem-meta' },
                [
                  audit.missingEntries.length > 0 ? `缺条目：${audit.missingEntries.map((row) => row.sessionId.slice(0, 16)).join('、')}` : null,
                  audit.orphanEntries.length > 0 ? `孤儿条目：${audit.orphanEntries.map((entry) => entry.id.slice(0, 12)).join('、')}` : null,
                  audit.emptySessions.length > 0 ? `空会话：${audit.emptySessions.map((id) => id.slice(0, 16)).join('、')}` : null,
                  audit.duplicateEntries.length > 0 ? `重复条目：${audit.duplicateEntries.map((row) => row.sessionId.slice(0, 16)).join('、')}` : null,
                  (audit.multiMemorySessions?.length ?? 0) > 0 ? `多记忆会话（应为 1 条）：${audit.multiMemorySessions.map((row) => `${row.sessionId.slice(0, 16)}(${row.count})`).join('、')}` : null,
                  (audit.attributeMismatches?.length ?? 0) > 0
                    ? `标题/分类分歧（索引 vs 会话记录）：${audit.attributeMismatches.map((row) => `${row.sessionId.slice(0, 16)}「${row.entryTitle ?? '—'}」/「${row.docTitle ?? '—'}」`).join('、')}`
                    : null,
                ].filter(Boolean).join(' ｜ ') || '（无异常）',
              ),
        ),
        draft.global.length === 0
          ? h('div', { className: 'dshmem-empty' }, '（全局索引为空）')
          : draft.global.map((entry) =>
              h(
                'div',
                { className: 'dshmem-entry', key: entry.id },
                h(
                  'div',
                  { className: 'dshmem-field' },
                  h('label', null, '标题'),
                  h('input', {
                    value: entry.title,
                    onChange: (event) => patchEntry(entry.id, 'title', event.target.value),
                  }),
                ),
                h(
                  'div',
                  { className: 'dshmem-field' },
                  h('label', null, '要点'),
                  h('textarea', {
                    value: entry.keyPoints,
                    rows: 2,
                    onChange: (event) => patchEntry(entry.id, 'keyPoints', event.target.value),
                  }),
                ),
                h(
                  'div',
                  { className: 'dshmem-field' },
                  h('label', null, '分类'),
                  h('input', {
                    value: entry.category,
                    onChange: (event) => patchEntry(entry.id, 'category', event.target.value),
                  }),
                ),
                h(
                  'div',
                  { className: 'dshmem-bar' },
                  h('span', { className: 'dshmem-meta' }, `${entry.sessionId} · 每会话 1 条，注入按最近活动排序`),
                  h('span', { style: { flex: 1 } }),
                  entry.linked === false
                    ? h('button', { className: 'dshmem-btn dshmem-del', onClick: () => removeEntry(entry.id) }, '删除孤儿条目')
                    : h('span', { className: 'dshmem-meta' }, '已关联会话：如需删除请到「会话记忆 → 删除整会话」'),
                ),
              ),
            ),
      )

      const num = (field, value) => h('input', {
        className: 'dshmem-num',
        type: 'number',
        value,
        onChange: (event) => {
          const raw = event.target.value
          setInjectCfg((current) => ({ ...current, [field]: raw === '' ? '' : Number(raw) }))
        },
      })

      const metricRow = (label, block) =>
        h(
          'tr',
          { key: label },
          h('td', null, label),
          h('td', null, block.chars.toLocaleString('en-US')),
          h('td', null, block.bytes.toLocaleString('en-US')),
          h('td', null, `~${block.tokens.toLocaleString('en-US')}`),
          h('td', { className: 'dshmem-meta' }, `~${block.dshTokens.toLocaleString('en-US')}`),
        )

      const injectBody =
        metrics === null
          ? h('div', { className: 'dshmem-empty' }, '（暂无注入数据）')
          : h(
              'div',
              null,
              h(
                'section',
                { className: 'dshmem-sec' },
                h('header', null, h('h4', null, '注入预算')),
                h(
                  'div',
                  { className: 'dshmem-field' },
                  h('label', null, '带要点条数'),
                  num('injectLimit', injectCfg.injectLimit),
                  h('span', { className: 'dshmem-meta' }, `生效 ${view.limits.injectLimit} · 可填 1–500。全部条目始终都会被列出；该值只决定前 N 条（按最近活动）显示要点，其余仅列标题`),
                ),
                h(
                  'div',
                  { className: 'dshmem-field' },
                  h('label', null, '字节预算'),
                  num('maxInjectBytes', injectCfg.maxInjectBytes),
                  h('span', { className: 'dshmem-meta' }, `生效 ${view.limits.maxInjectBytes} · 超预算时逐级降级：要点截断 → 仅标题 → 一行计数提示（索引不会被整块丢弃），画像才退化为首尾行`),
                ),
                h(
                  'div',
                  { className: 'dshmem-bar' },
                  h('button', { className: 'dshmem-btn', onClick: () => void previewConfig(), disabled: busy || previewing }, '预览'),
                  h('button', { className: 'dshmem-btn primary', onClick: () => void saveConfig(), disabled: busy || previewing }, '保存配置'),
                  h('span', { className: 'dshmem-meta' }, cfgStatus),
                ),
              ),
              h(
                'section',
                { className: 'dshmem-sec' },
                h(
                  'header',
                  null,
                  h('h4', null, '消耗估算'),
                  h('span', { className: 'dshmem-meta' }, `按条数 ${metrics.injectLimit} / 预算 ${metrics.maxInjectBytes} 计算`),
                ),
                h(
                  'table',
                  { className: 'dshmem-tbl' },
                  h(
                    'thead',
                    null,
                    h(
                      'tr',
                      null,
                      h('th', null, '区块'),
                      h('th', null, '字符'),
                      h('th', null, '字节'),
                      h('th', null, '估算 tokens'),
                      h('th', null, 'DSH 口径'),
                    ),
                  ),
                  h(
                    'tbody',
                    null,
                    metricRow('用户画像', metrics.profile),
                    metricRow(`全局索引（${metrics.index.entriesShown}/${metrics.index.entriesTotal} 条）`, metrics.index),
                    metricRow('实际注入合计', metrics.total),
                  ),
                ),
                h(
                  'div',
                  { className: 'dshmem-bar' },
                  h('span', { className: 'dshmem-meta' }, `占字节预算 ${(metrics.total.budgetShare * 100).toFixed(1)}%`),
                  metrics.trimmed
                    ? h('span', { className: 'dshmem-warn' }, '⚠ 已触发裁剪：索引块被丢弃或画像被截断')
                    : h('span', { className: 'dshmem-ok' }, '未触发裁剪'),
                ),
                h(
                  'div',
                  { className: 'dshmem-meta' },
                  '「估算 tokens」按 CJK≈0.7 token/字、其他 4 字符/token 折算；「DSH 口径」是 harness 自身 len/4 的固定密度估计（对中文偏低），用于与界面上的上下文占用对齐。',
                ),
              ),
            )

      const delta = (before, after) => {
        const diff = after - before
        const sign = diff === 0 ? '±0' : (diff > 0 ? '+' : '') + diff
        return `${before.toLocaleString('en-US')} → ${after.toLocaleString('en-US')} (${sign})`
      }

      const tidyBody =
        tidyDraft === null
          ? h(
              'section',
              { className: 'dshmem-sec' },
              h('header', null, h('h4', null, '整理模型（必须由你选择）')),
              h(
                'div',
                { className: 'dshmem-bar' },
                h(
                  'select',
                  {
                    className: 'dshmem-num',
                    value: modelCfg.provider,
                    onChange: (event) => {
                      const provider = event.target.value
                      setModelCfg({ provider, model: '', reasoningEffort: '' })
                      void loadCatalog(provider, '')
                    },
                  },
                  [h('option', { key: 'p0', value: '' }, '选择 provider…'), ...providers.map((p) => h('option', { key: p.id, value: p.id }, `${p.name} (${p.id})`))],
                ),
                h(
                  'select',
                  {
                    className: 'dshmem-num',
                    value: modelCfg.model,
                    disabled: catalogModels.length === 0,
                    onChange: (event) => {
                      const model = event.target.value
                      const hit = catalogModels.find((entry) => entry.id === model)
                      setModelCfg((current) => ({ ...current, model, reasoningEffort: '' }))
                      if (hit !== undefined) setModelStatus(`efforts: ${hit.efforts.map((e) => e.id).join(' / ') || '无（不提供档位）'}`)
                    },
                  },
                  [h('option', { key: 'm0', value: '' }, catalogModels.length === 0 ? '先选 provider' : '选择 model…'), ...catalogModels.map((m) => h('option', { key: m.id, value: m.id }, `${m.name} (${m.id})`))],
                ),
                h(
                  'select',
                  {
                    className: 'dshmem-num',
                    value: modelCfg.reasoningEffort,
                    onChange: (event) => setModelCfg((current) => ({ ...current, reasoningEffort: event.target.value })),
                  },
                  [
                    h('option', { key: 'e0', value: '' }, '推理档位：默认（不指定）'),
                    ...(catalogModels.find((m) => m.id === modelCfg.model)?.efforts ?? []).map((e) => h('option', { key: e.id, value: e.id }, `${e.name} (${e.id})`)),
                  ],
                ),
                h('button', { className: 'dshmem-btn', onClick: () => void saveModel(), disabled: tidyBusy }, '保存模型'),
                h('span', { className: 'dshmem-meta' }, modelStatus),
              ),
              h(
                'div',
                { className: 'dshmem-meta' },
                '档位来自该路由的模型目录：例如 deepseek-v4.1-flash 只提供 low / high / max（无 off），要彻底关掉推理需选声明了 off 的模型。对话里可用 /dream 生成建议、/dream apply 写入、/dream status 查看。',
              ),
              h(
                'div',
                { className: 'dshmem-meta' },
                commandReady ? '/dream 命令已注册' : '/dream 命令未注册（本组合没有 commands 服务）',
              ),
              h(
                'div',
                { className: 'dshmem-meta' },
                lastRun === null
                  ? '尚未整理过（推理型模型单次约 1.8 万 output tokens，建议为整理配置非推理模型）'
                  : `上次整理：${lastRun.ok ? '成功' : `失败(${lastRun.code})`} · output ${lastRun.outputTokens ?? '?'} tokens · 耗时 ${(lastRun.elapsedMs / 1000).toFixed(1)}s · ${new Date(lastRun.at).toLocaleString()}`,
              ),
              history.length === 0
                ? null
                : h(
                    'section',
                    { className: 'dshmem-sec' },
                    h('header', null, h('h4', null, '整理历史'), h('span', { className: 'dshmem-meta' }, `${history.length} 次（落盘 consolidation-log.json）`)),
                    h(
                      'table',
                      { className: 'dshmem-tbl' },
                      h(
                        'thead',
                        null,
                        h(
                          'tr',
                          null,
                          h('th', null, '时间'),
                          h('th', null, '模型 · 档位'),
                          h('th', null, 'output'),
                          h('th', null, '耗时'),
                          h('th', null, '注入 before→after'),
                          h('th', null, '结果'),
                        ),
                      ),
                      h(
                        'tbody',
                        null,
                        history.map((row) =>
                          h(
                            'tr',
                            { key: String(row.at) },
                            h('td', null, new Date(row.at).toLocaleString()),
                            h('td', null, `${row.model ?? '?'}${row.reasoningEffort === null || row.reasoningEffort === undefined ? '' : ` · ${row.reasoningEffort}`}`),
                            h('td', null, row.outputTokens === null || row.outputTokens === undefined ? '—' : Number(row.outputTokens).toLocaleString('en-US')),
                            h('td', null, `${(row.elapsedMs / 1000).toFixed(1)}s`),
                            h(
                              'td',
                              null,
                              row.beforeTokens === null || row.afterTokens === null
                                ? '—'
                                : `${row.beforeTokens} → ${row.afterTokens}（${(((row.afterTokens - row.beforeTokens) / row.beforeTokens) * 100).toFixed(0)}%）`,
                            ),
                            h('td', { className: row.ok ? 'dshmem-ok' : 'dshmem-warn' }, row.ok ? '成功' : `失败(${row.code ?? 'error'})`),
                          ),
                        ),
                      ),
                    ),
                  ),
              h(
                'div',
                { className: 'dshmem-bar' },
                h(
                  'button',
                  {
                    className: 'dshmem-btn primary',
                    onClick: () => void makeDraft(),
                    disabled: tidyBusy || savedCfg.provider.length === 0 || savedCfg.model.length === 0,
                  },
                  tidyBusy ? '生成中…' : '生成整理建议',
                ),
                savedCfg.provider.length === 0 || savedCfg.model.length === 0
                  ? h('span', { className: 'dshmem-warn' }, '先选择并保存整理模型')
                  : null,
                h('span', { className: 'dshmem-meta' }, tidyStatus),
              ),
            )
          : h(
              'div',
              null,
              h(
                'section',
                { className: 'dshmem-sec' },
                h(
                  'header',
                  null,
                  h('h4', null, '整理建议'),
                  h('span', { className: 'dshmem-meta' }, `${tidyDraft.target.provider}/${tidyDraft.target.model} · 来源 ${tidyDraft.target.source}`),
                ),
                h(
                  'table',
                  { className: 'dshmem-tbl' },
                  h(
                    'thead',
                    null,
                    h('tr', null, h('th', null, '指标'), h('th', null, '整理前 → 后')),
                  ),
                  h(
                    'tbody',
                    null,
                    h('tr', null, h('td', null, '画像 tokens'), h('td', null, delta(tidyDraft.evaluation.metrics.before.profile.tokens, tidyDraft.evaluation.metrics.after.profile.tokens))),
                    h('tr', null, h('td', null, '索引 tokens'), h('td', null, delta(tidyDraft.evaluation.metrics.before.index.tokens, tidyDraft.evaluation.metrics.after.index.tokens))),
                    h('tr', null, h('td', null, '注入合计 tokens'), h('td', null, delta(tidyDraft.evaluation.metrics.before.total.tokens, tidyDraft.evaluation.metrics.after.total.tokens))),
                    h('tr', null, h('td', null, '画像要点数'), h('td', null, `${tidyDraft.evaluation.counts.beforePoints} → ${tidyDraft.evaluation.counts.afterPoints}`)),
                    h('tr', null, h('td', null, '索引条目数'), h('td', null, `${tidyDraft.evaluation.counts.beforeEntries} → ${tidyDraft.evaluation.counts.afterEntries}`)),
                  ),
                ),
                tidyDraft.evaluation.merged.length > 0
                  ? h('div', { className: 'dshmem-meta' }, `合并：${tidyDraft.evaluation.merged.map((m) => `${m.title}（并入 ${m.from.length} 条）`).join('；')}`)
                  : null,
                tidyDraft.evaluation.removed.length > 0
                  ? h('div', { className: 'dshmem-meta' }, `丢弃索引条目：${tidyDraft.evaluation.removed.map((r) => r.title).join('；')}`)
                  : null,
                (tidyDraft.evaluation.removed.length > 0 || tidyDraft.evaluation.merged.length > 0)
                  ? h(
                      'div',
                      { className: 'dshmem-warn' },
                      `⚠ 建议稿会丢弃 ${tidyDraft.evaluation.removed.length} 条、合并 ${tidyDraft.evaluation.merged.length} 条索引条目——这会断开对应会话记忆与索引的关联，服务端会拒绝应用（索引与会话记忆必须一一对应）`,
                    )
                  : null,
                tidyDraft.evaluation.regression
                  ? h('div', { className: 'dshmem-warn' }, '⚠ 注入量未下降，将被拒绝应用')
                  : null,
                tidyDraft.evaluation.lostCritical.length > 0
                  ? h('div', { className: 'dshmem-warn' }, `⚠ 会丢失关键标识，将被拒绝应用：${tidyDraft.evaluation.lostCritical.slice(0, 6).join('、')}`)
                  : h('div', { className: 'dshmem-ok' }, '关键标识（路径/URL/编号/数字）校验通过'),
                h(
                  'div',
                  { className: 'dshmem-bar' },
                  h(
                    'button',
                    {
                      className: 'dshmem-btn primary',
                      onClick: () => void applyDraft(),
                      disabled: tidyBusy || tidyDraft.evaluation.regression || tidyDraft.evaluation.lostCritical.length > 0,
                    },
                    '应用',
                  ),
                  h('button', { className: 'dshmem-btn', onClick: () => void discardDraft(), disabled: tidyBusy }, '丢弃'),
                  h('button', { className: 'dshmem-btn', onClick: () => void makeDraft(), disabled: tidyBusy }, '重新生成'),
                  h('span', { className: 'dshmem-meta' }, tidyStatus),
                ),
              ),
            )

      const proposedRow = sessionDraft !== null && Array.isArray(sessionDraft.proposed) && sessionDraft.proposed.length > 0 ? sessionDraft.proposed[0] : null
      const proposedText = proposedRow === null ? '' : String(proposedRow.content ?? '')
      const absorbedCount = sessionDraft === null ? 0 : sessionDraft.evaluation.removed.length
      const choiceBtn = (key, label, active, onClick) => h(
        'button',
        { key, className: active ? 'dshmem-btn primary' : 'dshmem-btn', onClick, disabled: transferBusy },
        label,
      )
      const profilePointTotal = Object.values(draft.sections ?? {}).reduce((total, list) => total + (Array.isArray(list) ? list.length : 0), 0)
      const exportEstimate = estimateExport(
        sessionList ?? [],
        exportCfg.scope === 'sessions' ? exportCfg.picked : null,
        exportCfg.profile,
        profilePointTotal,
      )
      const planLines = describeImportPlan(importPlan === null ? null : importPlan.plan)
      const kb = (bytes) => `${(Number(bytes || 0) / 1024).toFixed(1)} KB`

      const transferBody = h(
        'div',
        null,
        h('div', { className: transferBusy ? 'dshmem-warn' : 'dshmem-meta' }, transferNote),

        h(
          'section',
          { className: 'dshmem-sec' },
          h('header', null, h('h4', null, '导出'), h('span', { className: 'dshmem-meta' }, '写出一个带校验和的 JSON bundle')),
          h(
            'div',
            { className: 'dshmem-bar' },
            choiceBtn('scope-all', '全量', exportCfg.scope === 'all', () => setExportCfg({ ...exportCfg, scope: 'all' })),
            choiceBtn('scope-profile', '仅画像', exportCfg.scope === 'profile', () => setExportCfg({ ...exportCfg, scope: 'profile' })),
            choiceBtn('scope-sessions', '仅会话', exportCfg.scope === 'sessions', () => {
              setExportCfg({ ...exportCfg, scope: 'sessions' })
              if (sessionList === null) void loadSessions()
            }),
            h('label', { className: 'dshmem-meta' }, h('input', {
              type: 'checkbox',
              checked: exportCfg.profile,
              onChange: (event) => setExportCfg({ ...exportCfg, profile: event.target.checked }),
            }), ' 包含画像'),
            h('input', {
              placeholder: '关键词（可选）',
              value: exportCfg.query,
              onChange: (event) => setExportCfg({ ...exportCfg, query: event.target.value }),
              style: { width: '160px' },
            }),
          ),
          exportCfg.scope === 'sessions'
            ? h(
                'div',
                { className: 'dshmem-list', style: { maxHeight: '180px' } },
                (sessionList ?? []).length === 0
                  ? h('div', { className: 'dshmem-empty' }, sessionList === null ? '（正在读取会话列表…）' : '（没有会话）')
                  : (sessionList ?? []).map((row) => h(
                      'label',
                      { className: 'dshmem-row', key: row.sessionId },
                      h('input', {
                        type: 'checkbox',
                        checked: exportCfg.picked.includes(row.sessionId),
                        onChange: (event) => setExportCfg({
                          ...exportCfg,
                          picked: event.target.checked
                            ? [...exportCfg.picked, row.sessionId]
                            : exportCfg.picked.filter((id) => id !== row.sessionId),
                        }),
                      }),
                      h('span', { className: 'dshmem-meta' }, ` ${row.title ?? '(无标题)'} · ${row.count} 条 · ${kb(row.bytes)} · ${row.sessionId.slice(0, 16)}`),
                    )),
              )
            : null,
          h(
            'div',
            { className: 'dshmem-bar' },
            h('span', { className: 'dshmem-meta' }, `预估：${exportEstimate.sessions} 个会话 · ${exportEstimate.memories} 条记忆 · 正文 ${kb(exportEstimate.contentBytes)} → 包体约 ${kb(exportEstimate.estimateBytes)}`),
            h('button', { className: 'dshmem-btn', onClick: () => void loadSessions(), disabled: transferBusy }, '刷新会话列表'),
          ),
          h(
            'div',
            { className: 'dshmem-bar' },
            choiceBtn('dest-transfer', '保存到交换目录', exportCfg.destMode === 'transfer', () => setExportCfg({ ...exportCfg, destMode: 'transfer' })),
            choiceBtn('dest-custom', '自定义路径', exportCfg.destMode === 'custom', () => setExportCfg({ ...exportCfg, destMode: 'custom' })),
            exportCfg.destMode === 'custom'
              ? h('input', {
                  placeholder: '~/Desktop/mem.json',
                  value: exportCfg.dest,
                  onChange: (event) => setExportCfg({ ...exportCfg, dest: event.target.value }),
                  style: { width: '260px' },
                })
              : h('span', { className: 'dshmem-meta' }, '导入可直接按文件名引用'),
          ),
          exportCfg.destMode === 'custom' && destHint(exportCfg.dest).length > 0
            ? h('div', { className: 'dshmem-meta' }, destHint(exportCfg.dest))
            : null,
          h(
            'div',
            { className: 'dshmem-bar' },
            h('label', { className: 'dshmem-meta' }, h('input', {
              type: 'checkbox',
              checked: exportCfg.overwrite,
              onChange: (event) => setExportCfg({ ...exportCfg, overwrite: event.target.checked }),
            }), ' 覆盖已存在文件'),
            h('label', { className: 'dshmem-meta' }, h('input', {
              type: 'checkbox',
              checked: exportCfg.reveal,
              onChange: (event) => setExportCfg({ ...exportCfg, reveal: event.target.checked }),
            }), ' 导出后在访达中定位'),
            h('span', { style: { flex: 1 } }),
            h('button', { className: 'dshmem-btn primary', onClick: () => void runExport(), disabled: transferBusy }, transferBusy ? '处理中…' : '生成导出'),
          ),
          exportResult === null
            ? null
            : h(
                'div',
                { className: 'dshmem-entry' },
                h('div', { className: 'dshmem-ok' }, `已导出 ${exportResult.file}`),
                h('div', { className: 'dshmem-meta' }, exportResult.path),
                h('div', { className: 'dshmem-meta' }, `${kb(exportResult.bytes)} · ${exportResult.counts.sessions} 会话 / ${exportResult.counts.memories} 记忆 / ${exportResult.counts.globalEntries} 条目${exportResult.revealed ? ' · 已在访达中定位' : ''}`),
                h('div', { className: 'dshmem-meta' }, exportResult.checksum),
                h('div', { className: 'dshmem-bar' },
                  h('button', {
                    className: 'dshmem-btn',
                    onClick: () => {
                      try { void navigator.clipboard.writeText(exportResult.path) } catch { /* clipboard may be unavailable */ }
                      setTransferNote('路径已复制到剪贴板')
                    },
                  }, '复制路径'),
                ),
              ),
        ),

        h(
          'section',
          { className: 'dshmem-sec' },
          h('header', null, h('h4', null, '导入'), h('span', { className: 'dshmem-meta' }, '先检查、后确认；写入前自动快照')),
          h(
            'div',
            { className: 'dshmem-bar' },
            choiceBtn('src-transfer', '交换目录', importPick.mode === 'transfer', () => setImportPick({ ...importPick, mode: 'transfer' })),
            choiceBtn('src-path', '绝对路径', importPick.mode === 'path', () => setImportPick({ ...importPick, mode: 'path' })),
            importPick.mode === 'transfer'
              ? h(
                  'select',
                  {
                    value: importPick.file,
                    onChange: (event) => { setImportPick({ ...importPick, file: event.target.value }); setImportPlan(null); setImportArm(false) },
                    style: { minWidth: '280px' },
                  },
                  [h('option', { key: '', value: '' }, '（选择 bundle）'), ...(transferFiles ?? []).map((file) => h('option', { key: file.file, value: file.file }, `${file.file} · ${kb(file.size)}`))],
                )
              : h('input', {
                  placeholder: '~/Desktop/mem.json',
                  value: importPick.path,
                  onChange: (event) => { setImportPick({ ...importPick, path: event.target.value }); setImportPlan(null); setImportArm(false) },
                  style: { width: '300px' },
                }),
            h('button', { className: 'dshmem-btn', onClick: () => void loadTransfer(), disabled: transferBusy }, '刷新列表'),
          ),
          h(
            'div',
            { className: 'dshmem-bar' },
            h('span', { className: 'dshmem-meta' }, '已存在会话时：'),
            choiceBtn('on-merge', '合并', importCfg.onExisting === 'merge', () => { setImportCfg({ ...importCfg, onExisting: 'merge' }); setImportPlan(null); setImportArm(false) }),
            choiceBtn('on-skip', '跳过', importCfg.onExisting === 'skip', () => { setImportCfg({ ...importCfg, onExisting: 'skip' }); setImportPlan(null); setImportArm(false) }),
            choiceBtn('on-replace', '替换', importCfg.onExisting === 'replace', () => { setImportCfg({ ...importCfg, onExisting: 'replace' }); setImportPlan(null); setImportArm(false) }),
            h('label', { className: 'dshmem-meta' }, h('input', {
              type: 'checkbox',
              checked: importCfg.remapSessions,
              onChange: (event) => { setImportCfg({ ...importCfg, remapSessions: event.target.checked }); setImportPlan(null); setImportArm(false) },
            }), ' 重映射 sessionId（并存）'),
            h('label', { className: 'dshmem-meta' }, h('input', {
              type: 'checkbox',
              checked: importCfg.replaceProfile,
              onChange: (event) => setImportCfg({ ...importCfg, replaceProfile: event.target.checked }),
            }), ' 整块替换画像'),
          ),
          h(
            'div',
            { className: 'dshmem-bar' },
            h('button', { className: 'dshmem-btn', onClick: () => void checkImport(), disabled: transferBusy }, '检查'),
            h('button', {
              className: importArm ? 'dshmem-btn dshmem-del' : 'dshmem-btn primary',
              onClick: () => void runImport(),
              disabled: transferBusy || importPlan === null,
            }, importArm ? '确认导入' : '导入'),
            h('span', { className: 'dshmem-meta' }, importPlan === null ? '需先「检查」' : '检查通过，可导入'),
          ),
          importPlan === null
            ? null
            : h(
                'div',
                { className: 'dshmem-entry' },
                h('div', { className: 'dshmem-meta' }, `来源 ${importPlan.source.plugin} ${importPlan.source.version} · 导出于 ${importPlan.exportedAt}`),
                h('div', { className: 'dshmem-meta' }, `计数：${importPlan.counts.sessions} 会话 / ${importPlan.counts.memories} 记忆 / ${importPlan.counts.globalEntries} 条目 · 校验和通过`),
                ...planLines.map((line, index) => h('div', { className: 'dshmem-meta', key: `plan-${index}` }, line)),
              ),
          importResult === null
            ? null
            : h(
                'div',
                { className: 'dshmem-entry' },
                h('div', { className: 'dshmem-ok' }, `导入完成 · 快照 ${importResult.snapshot}`),
                h('div', { className: 'dshmem-meta' }, `新建 ${importResult.report.created.length} · 合并 ${importResult.report.merged.length} · 跳过 ${importResult.report.skipped.length} · 替换 ${importResult.report.replaced.length} · 拒绝 ${importResult.report.rejected.length}`),
                h('div', { className: 'dshmem-meta' }, `画像：新增 ${importResult.report.profileAdded} · 跳过 ${importResult.report.profileSkipped}${importResult.report.profileReplaced ? ' · 已整块替换' : ''} · 补建条目 ${importResult.report.entriesBuilt.length} · 重映射 ${importResult.report.remapped.length}`),
                h('div', { className: importResult.audit.missingEntries + importResult.audit.orphanEntries === 0 ? 'dshmem-ok' : 'dshmem-warn' }, `契约校验：缺条目 ${importResult.audit.missingEntries} · 孤儿 ${importResult.audit.orphanEntries}`),
                ...importResult.report.rejected.map((row, index) => h('div', { className: 'dshmem-warn', key: `rej-${index}` }, `拒绝 ${row.sessionId}：${row.reason}`)),
                h('div', { className: 'dshmem-bar' },
                  h('button', { className: 'dshmem-btn dshmem-del', onClick: () => void rollbackTransfer(importResult.snapshot), disabled: transferBusy }, '回滚本次导入'),
                ),
              ),
        ),

        h(
          'section',
          { className: 'dshmem-sec' },
          h('header', null, h('h4', null, '导入快照'), h('span', { className: 'dshmem-meta' }, '可回滚；写入前生成')),
          (snapshots ?? []).length === 0
            ? h('div', { className: 'dshmem-empty' }, snapshots === null ? '（正在读取…）' : '（暂无快照）')
            : (snapshots ?? []).map((row) => h(
                'div',
                { className: 'dshmem-row', key: row.snapshot },
                h('div', { style: { flex: 1, minWidth: 0 } },
                  h('div', null, row.snapshot),
                  h('div', { className: 'dshmem-meta' }, `${row.at === null ? '—' : new Date(row.at).toLocaleString()} · ${row.files} 个文件 · 含 ${row.sessions} 个会话 · 新建 ${row.created}`),
                ),
                row.rollbackable
                  ? h('button', { className: 'dshmem-btn', onClick: () => void rollbackTransfer(row.snapshot), disabled: transferBusy }, '回滚')
                  : h('span', { className: 'dshmem-meta' }, '不可回滚（无 manifest）'),
              )),
        ),
      )

      const pendingMemoryIds = new Set(memoryRemovals.map((row) => row.memoryId))
      const pendingSessionIds = new Set(sessionRemovals)

      const sessionsBody = h(
        'div',
        null,
        h(
          'section',
          { className: 'dshmem-sec' },
          h('header', null, h('h4', null, '会话记忆'), h('span', { className: 'dshmem-meta' }, sessionStatus)),
          h(
            'div',
            { className: 'dshmem-bar' },
            h('button', { className: 'dshmem-btn', onClick: () => void loadSessions() }, '刷新列表'),
            h(
              'span',
              { className: pendingMemoryIds.size + pendingSessionIds.size > 0 ? 'dshmem-warn' : 'dshmem-meta' },
              `待删除：${memoryRemovals.length} 条记忆 / ${sessionRemovals.length} 个会话（点底部「保存修改」提交，删除前请确认）`,
            ),
          ),
          h(
            'div',
            { className: 'dshmem-split' },
            h(
              'div',
              { className: 'dshmem-list' },
              sessionList === null
                ? h('div', { className: 'dshmem-empty' }, '（尚未加载）')
                : sessionList.map((row) =>
                h(
                  'div',
                  {
                    className: `dshmem-row${sessionDetail !== null && sessionDetail.sessionId === row.sessionId ? ' sel' : ''}`,
                    key: row.sessionId,
                  },
                  h(
                    'button',
                    {
                      className: `dshmem-btn${sessionDetail !== null && sessionDetail.sessionId === row.sessionId ? ' primary' : ''}`,
                      onClick: () => void loadSession(row.sessionId),
                    },
                    '查看',
                  ),
                  h(
                    'div',
                    { style: { flex: 1, minWidth: 0 } },
                    h('div', null, row.title === null ? '（无标题）' : row.title),
                    h(
                      'div',
                      { className: 'dshmem-meta' },
                      `${row.sessionId} · ${row.count} 条 · ${(row.bytes / 1024).toFixed(1)} KB · ${row.updatedAt === null ? '—' : new Date(row.updatedAt).toLocaleString()}`,
                    ),
                  ),
                  pendingSessionIds.has(row.sessionId)
                    ? h('span', { className: 'dshmem-warn' }, '待删除')
                    : h('button', { className: 'dshmem-btn dshmem-del', onClick: () => queueSessionRemoval(row.sessionId) }, '删除整会话'),
                ),
              ),
            ),
            h(
              'div',
              { className: 'dshmem-detail' },
              sessionDetail === null
                ? h('div', { className: 'dshmem-empty' }, '点左侧「查看」在此显示该会话的记忆')
                : h(
              'div',
              null,
              h(
                'header',
                null,
                h('h4', null, `记忆明细 · ${sessionDetail.memories.length} 条`),
                h('span', { className: 'dshmem-meta' }, sessionDetail.sessionId),
              ),
              h(
                'div',
                { className: 'dshmem-bar' },
                h(
                  'button',
                  {
                    className: 'dshmem-btn primary',
                    onClick: () => void makeSessionDraft(sessionDetail.sessionId),
                    // 单条也需要整理：合并式保存会把新事实追加进这一条，久了就该压缩重写。
                    disabled: dreamBusy || sessionDetail.memories.length === 0,
                  },
                  dreamBusy ? '生成中…' : '整理该会话（模型压缩）',
                ),
                h(
                  'button',
                  {
                    className: 'dshmem-btn',
                    onClick: () => {
                      const content = sessionDetail.memories[0]?.content ?? ''
                      const entry = (draft.global ?? []).find((row) => row.sessionId === sessionDetail.sessionId)
                      setRewriteDraft(content)
                      setRewriteKeyPoint(typeof entry?.keyPoints === 'string' ? entry.keyPoints : '')
                      setRewriteArm(false)
                      setSessionDraftStatus(`将重写该会话的唯一一条记忆（当前 ${Array.from(content).length} 字）`)
                    },
                    disabled: dreamBusy || sessionDetail.memories.length === 0,
                  },
                  '重写这条',
                ),
                sessionDetail.memories.length > 1
                  ? h(
                  'button',
                  {
                    className: 'dshmem-btn',
                    onClick: async () => {
                      setSessionDraftStatus('正在折叠…')
                      const result = await api('POST', { ops: [{ op: 'session.collapse', sessionId: sessionDetail.sessionId }] })
                      if (result.ok !== true) {
                        setSessionDraftStatus(`折叠被拒：${result.message || result.code}`)
                        return
                      }
                      setState({ phase: 'ready', view: result })
                      setDraft(draftOf(result))
                      setSessionDraftStatus((result.actions ?? []).join('；') || '已是单条')
                      void loadSessions()
                      void loadSession(sessionDetail.sessionId)
                    },
                    disabled: dreamBusy,
                  },
                  `折叠为一条（不调用模型，当前 ${sessionDetail.memories.length} 条）`,
                )
                  : null,
                h('span', { className: 'dshmem-meta' }, '合并同主题、删除重复与已被推翻/过时的内容；应用前自动快照，可回滚'),
              ),
              sessionDraftStatus.length === 0 ? null : h('div', { className: 'dshmem-meta' }, sessionDraftStatus),
              rewriteDraft === null
                ? null
                : h(
                    'div',
                    { className: 'dshmem-entry' },
                    h('div', { className: 'dshmem-meta' }, `重写为（当前 ${Array.from(rewriteDraft).length} 字，上限 16000）`),
                    h('textarea', {
                      value: rewriteDraft,
                      rows: 10,
                      style: { width: '100%' },
                      onChange: (event) => setRewriteDraft(event.target.value),
                    }),
                    h(
                      'div',
                      { className: 'dshmem-field' },
                      h('label', null, '索引摘要（keyPoint，留空自动推导）'),
                      h('input', {
                        value: rewriteKeyPoint,
                        onChange: (event) => setRewriteKeyPoint(event.target.value),
                      }),
                    ),
                    h(
                      'div',
                      { className: 'dshmem-bar' },
                      h('button', {
                        className: rewriteArm ? 'dshmem-btn dshmem-del' : 'dshmem-btn primary',
                        onClick: () => void submitRewrite(sessionDetail.sessionId),
                        disabled: dreamBusy || rewriteDraft.trim().length === 0,
                      }, rewriteArm ? '确认重写' : '重写'),
                      h('button', {
                        className: 'dshmem-btn',
                        onClick: () => { setRewriteDraft(null); setRewriteKeyPoint(''); setRewriteArm(false); setSessionDraftStatus('已取消重写') },
                        disabled: dreamBusy,
                      }, '取消'),
                    ),
                  ),
              sessionDraft === null
                ? null
                : h(
                    'div',
                    { className: 'dshmem-sec' },
                    h(
                      'header',
                      null,
                      h('h4', null, '会话整理建议'),
                      h('span', { className: 'dshmem-meta' }, `${sessionDraft.target.provider}/${sessionDraft.target.model}${sessionDraft.target.reasoningEffort === null ? '' : ` · ${sessionDraft.target.reasoningEffort}`}`),
                    ),
                    h(
                      'table',
                      { className: 'dshmem-tbl' },
                      h('thead', null, h('tr', null, h('th', null, '指标'), h('th', null, '整理前 → 后'))),
                      h(
                        'tbody',
                        null,
                        h('tr', null, h('td', null, '记忆条数'), h('td', null, `${sessionDraft.evaluation.counts.beforeMemories} → ${sessionDraft.evaluation.counts.afterMemories}`)),
                        h('tr', null, h('td', null, '字符'), h('td', null, `${sessionDraft.evaluation.metrics.before.total.chars} → ${sessionDraft.evaluation.metrics.after.total.chars}`)),
                        h('tr', null, h('td', null, '字节'), h('td', null, `${sessionDraft.evaluation.metrics.before.total.bytes} → ${sessionDraft.evaluation.metrics.after.total.bytes}`)),
                        h('tr', null, h('td', null, '估算 tokens'), h('td', null, `${sessionDraft.evaluation.metrics.before.total.tokens} → ${sessionDraft.evaluation.metrics.after.total.tokens}`)),
                      ),
                    ),
                    h(
                      'div',
                      { className: 'dshmem-meta' },
                      `由 ${sessionDraft.evaluation.counts.beforeMemories} 条合成 1 条：新增 0 条、合并 ${absorbedCount} 个来源、删除过时或被推翻的旧值`,
                    ),
                    h(
                      'div',
                      { className: 'dshmem-entry' },
                      h('div', { className: 'dshmem-meta' }, '建议内容（应用后成为该会话唯一的记忆）'),
                      h(
                        'div',
                        { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '260px', overflow: 'auto' } },
                        proposedText.length === 0 ? '（模型未返回 content）' : proposedText,
                      ),
                    ),
                    absorbedCount > 0
                      ? h(
                          'div',
                          { className: 'dshmem-meta' },
                          `被合并的来源 ${absorbedCount} 条：${sessionDraft.evaluation.removed.map((r) => r.title.replace(/\s+/g, ' ').slice(0, 34)).join('；')}`,
                        )
                      : null,
                    sessionDraft.evaluation.lostCritical.length > 0
                      ? h('div', { className: 'dshmem-warn' }, `随丢弃一并移除的标识：${sessionDraft.evaluation.lostCritical.slice(0, 6).join('、')}（会话整理允许丢弃过时内容；不认可就丢弃本次建议）`)
                      : h('div', { className: 'dshmem-ok' }, '未丢失标识'),
                    sessionDraft.evaluation.regression
                      ? h('div', { className: 'dshmem-warn' }, '⚠ 体积未下降，将被拒绝应用')
                      : null,
                    h(
                      'div',
                      { className: 'dshmem-bar' },
                      h(
                        'button',
                        {
                          className: 'dshmem-btn primary',
                          onClick: () => void applySessionDraft(),
                          disabled: dreamBusy || sessionDraft.evaluation.regression,
                        },
                        '应用',
                      ),
                      h('button', { className: 'dshmem-btn', onClick: () => void discardSessionDraft(), disabled: dreamBusy }, '丢弃'),
                      h('button', { className: 'dshmem-btn', onClick: () => void makeSessionDraft(sessionDetail.sessionId), disabled: dreamBusy }, '重新生成'),
                    ),
                  ),
              sessionDetail.memories.length === 0
                ? h('div', { className: 'dshmem-empty' }, '（空）')
                : sessionDetail.memories.map((memory) =>
                    h(
                      'div',
                      { className: 'dshmem-entry', key: memory.id },
                      h(
                        'div',
                        { className: 'dshmem-meta' },
                        `${memory.category} · ${memory.createdAt === null ? '—' : new Date(memory.createdAt).toLocaleString()} · ${String(memory.id).slice(0, 8)}`,
                      ),
                      h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, memory.content),
                      h(
                        'div',
                        { className: 'dshmem-bar' },
                        h('span', { style: { flex: 1 } }),
                        pendingMemoryIds.has(memory.id)
                          ? h('span', { className: 'dshmem-warn' }, '待删除')
                          : h('button', { className: 'dshmem-btn dshmem-del', onClick: () => queueMemoryRemoval(sessionDetail.sessionId, memory.id) }, '删除该条'),
                      ),
                    ),
                  ),
              ),
            ),
          ),
        ),
      )

      return h(
        'div',
        { className: 'dshmem' },
        header,
        tab === 'profile'
          ? profileBody
          : tab === 'global'
            ? globalBody
            : tab === 'inject'
              ? injectBody
              : tab === 'sessions'
                ? sessionsBody
                : tab === 'transfer'
                  ? transferBody
                  : tidyBody,
        h(
          'div',
          { className: 'dshmem-bar' },
          h('button', { className: 'dshmem-btn primary', onClick: () => void save(), disabled: busy || !dirty }, busy ? '保存中…' : '保存修改'),
          h('span', { className: dirty ? 'dshmem-ok' : 'dshmem-meta' }, dirty ? '有未保存的改动' : '无未保存改动'),
          h('span', { style: { flex: 1 } }),
          h('span', { className: 'dshmem-ok' }, status),
        ),
        h('div', { className: 'dshmem-meta' }, `存储：${view.root}（JSON 为唯一事实源；保存后写入纳入与模型 save_memory 相同的串行锁）`),
      )
    }

    // The summary render cannot await the bridge, so it renders its own loader.
    function MemorySummary() {
      const [text, setText] = react.useState('记忆库')
      react.useEffect(() => {
        let alive = true
        api('GET')
          .then((view) => {
            if (alive && view && view.ok === true) {
              const tokens = view.injection === undefined ? null : view.injection.total.tokens
              setText(
                `记忆库 · 画像 ${view.stats.profilePoints} 点 / 全局索引 ${view.stats.globalEntries} 条`
                + (tokens === null ? '' : ` · 注入约 ${tokens.toLocaleString('en-US')} tokens`),
              )
            }
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [])
      return text
    }

    function RowConfig(slotProps) {
      const view = slotProps !== null && typeof slotProps === 'object' ? slotProps.view : undefined
      return view === 'summary' ? h(MemorySummary) : h(MemoryPage)
    }

    function apply(ctx) {
      ensureStyle()
      ctx.slots.inject('plugins.row.config', () =>
        ctx.slots.register(
          { name: 'plugins.row.config', key: 'dsh-structured-memory#dsh-structured-memory' },
          RowConfig,
        ),
      )
    }

    exports.__internals = { estimateExport, describeImportPlan, destHint }
    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
