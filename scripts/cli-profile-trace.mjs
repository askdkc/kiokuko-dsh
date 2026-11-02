/** Observe actual ESM package loads in the private CLI acceptance process. */
import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const file = process.env.KIOKUKO_CLI_PROBE_EVENTS
if (!file) throw new Error('A private observation file is required')
const seen = new Set(), modules = new Set()
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
        if (['kiokuko-dsh', '@askdkc/dsh-cli'].includes(value.name) && !modules.has(url)) {
          modules.add(url)
          const loaded = result.source
          const bytes = typeof loaded === 'string' || ArrayBuffer.isView(loaded) ? loaded : readFileSync(fileURLToPath(url))
          appendFileSync(file, JSON.stringify({ time: Date.now(), type: 'runtime-module', name: value.name,
            version: value.version, entry: url, sha256: createHash('sha256').update(bytes).digest('hex'),
            hashKind: loaded === bytes ? 'loader-source' : 'entry-file' }) + '\n', { mode: 0o600 })
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
