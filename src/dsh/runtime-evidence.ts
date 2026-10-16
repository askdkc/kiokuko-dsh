import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Observed launcher identity; a plugin's dependency tree is not the running host. */
export function runtimeEvidence(entry = process.argv[1]) {
  const unknown = { nodeVersion: process.version, dshVersion: null as string | null, launcher: null as { name: string; version: string } | null }
  if (!entry) return unknown
  try {
    let directory = dirname(realpathSync(resolve(entry)))
    for (;;) {
      let manifest: { name?: unknown; version?: unknown } | undefined
      try { manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return unknown }
      if (manifest) {
        if (!['@deepseek-ai/dsh', '@deepseek-ai/dsh-app-boot', '@askdkc/dsh-cli'].includes(String(manifest.name))
          || typeof manifest.version !== 'string' || !/^[0-9][0-9A-Za-z.+-]{0,127}$/u.test(manifest.version)) return unknown
        const launcher = { name: String(manifest.name), version: manifest.version }
        return { ...unknown, launcher, dshVersion: launcher.name === '@askdkc/dsh-cli' ? null : launcher.version }
      }
      const parent = dirname(directory)
      if (parent === directory) return unknown
      directory = parent
    }
  } catch { return unknown }
}
