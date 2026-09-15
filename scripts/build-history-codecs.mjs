import { build } from 'esbuild'
import { isBuiltin } from 'node:module'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/dsh/legacy-session-codecs.ts'],
  outfile: 'dist/dsh/legacy-session-codecs.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  // The migration uses only this exported value reader; the service entry has runtime side effects.
  alias: { '@deepseek-ai/dsh-llm': '@deepseek-ai/dsh-llm/assistant-stream' },
  sourcemap: true,
  metafile: true,
  legalComments: 'eof',
})
for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (dependency.external && !isBuiltin(dependency.path)) {
      throw new Error(`History codec bundle left a runtime dependency: ${dependency.path}`)
    }
  }
}
