/** A small test registry: zero dependencies, so the suite runs on plain node. */
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

/* --------------------------- web bridge harness -------------------------- */

/**
 * Mount the plugin's loopback bridges against a fake web server and return the
 * registered routes. `ctx.effect` invokes its callback immediately (that is the
 * Cordis contract the plugin relies on), so registration happens synchronously.
 */
export async function bridgeRoutes(config, services = {}) {
  const { apply } = await import('../../index.js')
  const routes = new Map()
  const webCtx = {
    webServer: {
      register: (route) => { routes.set(route.path, route); return () => {} },
    },
    // The /dream command injects `commands` on its own context.
    commands: { register: () => () => {} },
    get: (key) => services[key],
    effect: (fn) => fn(),
  }
  const ctx = {
    tools: { register: () => () => {} },
    systemPrompt: { context: () => () => {} },
    inject: (_deps, callback) => { callback(webCtx) },
    get: () => undefined,
    on: () => {},
    effect: (fn) => fn(),
  }
  apply(ctx, config)
  return routes
}

export function fakeRequest({ method = 'GET', url = '/', body, address = '127.0.0.1' } = {}) {
  const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  return {
    method,
    url,
    socket: { remoteAddress: address },
    async *[Symbol.asyncIterator]() {
      if (payload !== null) yield payload
    },
  }
}

export function fakeResponse() {
  const out = { status: 0, headers: null, body: '' }
  const res = {
    writeHead(status, headers) { out.status = status; out.headers = headers ?? null; return res },
    end(chunk) { out.body = chunk === undefined ? '' : String(chunk) },
  }
  return { res, out }
}

/** Call one registered route and decode its JSON answer. */
export async function callRoute(route, options = {}) {
  const { res, out } = fakeResponse()
  await route.handler(fakeRequest(options), res)
  let json = null
  try { json = JSON.parse(out.body) } catch { /* not JSON */ }
  return { status: out.status, json, raw: out.body }
}

/** Read a JSON file from the store, or null when absent. */
export async function readStoreFile(dir, name) {
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  try { return JSON.parse(await readFile(join(dir, name), 'utf8')) } catch { return null }
}
