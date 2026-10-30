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
