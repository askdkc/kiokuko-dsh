/** Observe actual ESM package loads in the private CLI acceptance process. */
import { registerHooks } from 'node:module'
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const file = process.env.KIOKUKO_CLI_PROBE_EVENTS
if (!file) throw new Error('A private observation file is required')
const seen = new Set()
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.startsWith('file:')) return result
    let directory = dirname(fileURLToPath(url))
    for (let depth = 0; depth < 18; depth++) {
      const manifest = join(directory, 'package.json')
      try {
        const value = JSON.parse(readFileSync(manifest, 'utf8'))
        if (value.name && /^(?:@deepseek-ai\/|@askdkc\/dsh-cli$|kiokuko-dsh$)/.test(value.name) && !seen.has(manifest)) {
          seen.add(manifest)
          appendFileSync(file, JSON.stringify({ time: Date.now(), type: 'runtime-package', name: value.name,
            version: value.version, manifest, entry: url }) + '\n', { mode: 0o600 })
        }
        break
      } catch {}
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
    return result
  },
})
