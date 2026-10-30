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
  let timer
  try {
    await Promise.race([
      fn(),
      // Cleared in `finally`: a pending timer would otherwise keep the process
      // alive for its full duration after the last test finished.
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout after 10s')), 10_000) }),
    ])
    passed += 1
    console.log(`ok   ${name} (${Date.now() - started}ms)`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL ${name}`)
    const lines = String(error?.stack ?? error).split('\n').slice(0, 6)
    for (const line of lines) console.log(`     ${line}`)
  } finally {
    clearTimeout(timer)
  }
}

console.log(`\n${passed}/${cases.length} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
