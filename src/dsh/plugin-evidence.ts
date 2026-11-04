import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Captured at module load, so replacing files cannot make an old process claim a new build. */
export const loadedPluginEvidence = (() => {
  let directory = dirname(fileURLToPath(import.meta.url))
  const loadedFrom = import.meta.url.includes('/dist/') ? 'distribution' : 'source'
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
      if (pkg.name === 'kiokuko-dsh') {
        let buildId: string | null = null, sourceCommit: string | null = null
        if (loadedFrom === 'distribution') try {
          const build = JSON.parse(readFileSync(join(directory, 'dist/build-info.json'), 'utf8'))
          if (build.schema === 'kiokuko.build.v1' && build.packageVersion === pkg.version && /^[a-f0-9]{64}$/u.test(build.buildId)) {
            buildId = build.buildId
            if (/^[a-f0-9]{40}$/u.test(build.sourceCommit)) sourceCommit = build.sourceCommit
          }
        } catch { /* Legacy artifacts explicitly report missing identity. */ }
        return Object.freeze({ pluginVersion: String(pkg.version), loadedFrom, buildId, sourceCommit, nodeVersion: process.version })
      }
    } catch { /* Walk to the package owning this module, never the caller's cwd. */ }
    const parent = dirname(directory)
    if (parent === directory) return Object.freeze({ pluginVersion: 'unknown', loadedFrom, buildId: null, sourceCommit: null, nodeVersion: process.version })
    directory = parent
  }
})()
