/**
 * dsh-memory search index (v2.2): FTS5 full-text retrieval over session
 * memories, backed by node:sqlite (zero new dependencies).
 *
 * Design:
 *   - JSON files remain the source of truth; this SQLite file is a DERIVED,
 *     rebuildable read-only index (memory.db next to global.json).
 *   - FTS5 with the 'trigram' tokenizer handles CJK well for substrings of
 *     3+ characters; queries shorter than 3 characters (or FTS failures)
 *     fall back to a LIKE scan — so 2-character Chinese words keep working.
 *   - Every operation is fault-tolerant: if SQLite is unavailable, corrupt,
 *     or locked, methods degrade silently (search → empty, upsert/delete →
 *     no-op) and the plugin keeps working with substring recall.
 *
 * @module dsh-memory-search
 */

const MEMORY_SEARCH_APPLICATION_ID = 0x44534d31 // 'DSM1' — guard against cross-app reuse
const FTS_MIN_CHARS = 3

/**
 * Open (create if needed) the search index at `<memoryDir>/memory.db`.
 * @returns {{ db: import('node:sqlite').DatabaseSync, rebuild, upsert, remove, removeSession, search, close } | null}
 *          null when node:sqlite is unavailable or the file cannot be opened.
 */
export async function openSearchIndex({ memoryDir }) {
  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    return null
  }
  const { join } = await import('node:path')
  const dbPath = join(memoryDir, 'memory.db')
  let db
  try {
    db = new DatabaseSync(dbPath)
    db.exec(`PRAGMA application_id = ${MEMORY_SEARCH_APPLICATION_ID}`)
    db.exec('CREATE TABLE IF NOT EXISTS mem_meta ('
      + 'memoryId TEXT PRIMARY KEY,'
      + 'sessionId TEXT,'
      + 'category TEXT,'
      + 'createdAt INTEGER)')
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS mem_idx USING fts5("
      + "content, sessionId UNINDEXED, memoryId UNINDEXED, category UNINDEXED, createdAt UNINDEXED,"
      + " tokenize='trigram')")
  } catch {
    try { db?.close() } catch { /* ignore */ }
    return null
  }

  /** Empty the index (used by rebuild). */
  const clear = () => {
    db.exec('DELETE FROM mem_idx')
    db.exec('DELETE FROM mem_meta')
  }

  /** Insert or replace one memory row. Safe to call repeatedly (idempotent). */
  const upsert = ({ sessionId, memoryId, category, content, createdAt }) => {
    try {
      const text = String(content ?? '')
      if (!text.trim()) return
      db.prepare('DELETE FROM mem_idx WHERE memoryId = ?').run(String(memoryId ?? ''))
      db.prepare('INSERT OR REPLACE INTO mem_meta (memoryId, sessionId, category, createdAt)'
        + ' VALUES (?, ?, ?, ?)').run(String(memoryId ?? ''), String(sessionId ?? ''), String(category ?? 'general'), Number(createdAt ?? 0))
      db.prepare('INSERT INTO mem_idx (content, sessionId, memoryId, category, createdAt)'
        + ' VALUES (?, ?, ?, ?, ?)').run(text, String(sessionId ?? ''), String(memoryId ?? ''), String(category ?? 'general'), Number(createdAt ?? 0))
    } catch {
      /* degrade silently */
    }
  }

  /** Delete one memory row; no-op when absent. */
  const remove = ({ memoryId }) => {
    try {
      db.prepare('DELETE FROM mem_idx WHERE memoryId = ?').run(String(memoryId ?? ''))
      db.prepare('DELETE FROM mem_meta WHERE memoryId = ?').run(String(memoryId ?? ''))
    } catch {
      /* degrade silently */
    }
  }

  /** Remove all rows belonging to one session. */
  const removeSession = ({ sessionId }) => {
    try {
      db.prepare('DELETE FROM mem_idx WHERE sessionId = ?').run(String(sessionId ?? ''))
      db.prepare('DELETE FROM mem_meta WHERE sessionId = ?').run(String(sessionId ?? ''))
    } catch {
      /* degrade silently */
    }
  }

  /**
   * Full rebuild from the current sessions/*.json files. Idempotent.
   *
   * NOTE: this clears the index before re-inserting, so callers MUST await it
   * before serving searches — an un-awaited rebuild leaves a window in which
   * searches see an empty index (observed: the first query after a restart
   * returned nothing).
   * @returns {Promise<{ inserted: number, sawMemories: boolean }>} rows indexed,
   *          and whether any session file actually held memories (lets the
   *          caller tell "empty store" from "silent rebuild failure").
   */
  const rebuild = async () => {
    let inserted = 0
    let sawMemories = false
    try {
      const { readdir, readFile } = await import('node:fs/promises')
      const { join: j } = await import('node:path')
      const sessionsDir = j(memoryDir, 'sessions')
      let files = []
      try {
        files = (await readdir(sessionsDir)).filter((f) => f.endsWith('.json'))
      } catch {
        files = []
      }
      clear()
      const stmtMeta = db.prepare('INSERT OR REPLACE INTO mem_meta (memoryId, sessionId, category, createdAt) VALUES (?, ?, ?, ?)')
      const stmtIdx = db.prepare('INSERT INTO mem_idx (content, sessionId, memoryId, category, createdAt) VALUES (?, ?, ?, ?, ?)')
      for (const file of files) {
        let doc
        try {
          doc = JSON.parse(await readFile(j(sessionsDir, file), 'utf8'))
        } catch {
          continue
        }
        const sid = typeof doc.sessionId === 'string' ? doc.sessionId : file.replace(/\.json$/, '')
        const memories = Array.isArray(doc.memories) ? doc.memories : []
        for (const m of memories) {
          if (!m || typeof m.content !== 'string' || !m.content.trim()) continue
          sawMemories = true
          stmtMeta.run(String(m.id ?? ''), sid, String(m.category ?? 'general'), Number(m.createdAt ?? 0))
          stmtIdx.run(String(m.content), sid, String(m.id ?? ''), String(m.category ?? 'general'), Number(m.createdAt ?? 0))
          inserted += 1
        }
      }
    } catch {
      /* degrade silently */
    }
    return { inserted, sawMemories }
  }

  /** Normalize a user query into an FTS5-safe phrase (double-quote escaping). */
  const ftsPhrase = (q) => `"${String(q).replace(/"/g, '""')}"`

  /**
   * Search memories. Uses FTS5 for 3+ char queries (with LIKE fallback on
   * zero/failed matches); always falls back to LIKE for shorter queries.
   * @param {string} query
   * @param {{ limit?: number, category?: string, sessionId?: string }} opts
   * @returns {Array<{sessionId, memoryId, category, createdAt, content}>}
   */
  const search = (query, opts = {}) => {
    const q = String(query ?? '').trim()
    if (!q) return []
    const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 50
    const category = typeof opts.category === 'string' && opts.category ? opts.category.toLowerCase() : ''
    const conds = [
      category ? 'LOWER(category) = ?' : null,
      opts.sessionId ? 'sessionId = ?' : null,
    ].filter(Boolean)
    const tail = conds.length > 0 ? ` AND ${conds.join(' AND ')}` : ''
    const args = [category ? category.toLowerCase() : null, opts.sessionId ? String(opts.sessionId) : null].filter((v) => v !== null)
    const projection = 'content, sessionId, memoryId, category, createdAt'

    // FTS5 path: requires >= 3 characters (trigram granularity) plus a
    // succeed-with-results guarantee; otherwise LIKE is at least as good.
    if ([...q].length >= FTS_MIN_CHARS) {
      try {
        const rows = db.prepare(
          `SELECT ${projection} FROM mem_idx WHERE mem_idx MATCH ?${tail} ORDER BY createdAt DESC LIMIT ?`
        ).all(ftsPhrase(q), ...args, limit)
        if (rows.length > 0) return rows
      } catch {
        /* fall through to LIKE */
      }
    }

    // LIKE fallback (substring across the whole content, CJK-safe).
    // If this ALSO fails, the index itself is unusable: rethrow so the caller
    // can detect the outage and fall back to scanning the JSON source of truth.
    try {
      const rows = db.prepare(
        `SELECT ${projection} FROM mem_idx WHERE content LIKE ?${tail} ORDER BY createdAt DESC LIMIT ?`
      ).all(`%${q}%`, ...args, limit)
      return rows
    } catch (err) {
      throw err
    }
  }

  /** Close the database handle. */
  const close = () => {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }

  return { db, rebuild, upsert, remove, removeSession, search, close }
}
