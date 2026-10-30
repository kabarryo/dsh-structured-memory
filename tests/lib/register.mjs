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
