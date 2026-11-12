import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'

/** Obtain the shipped carrier through the plugin's public panel registration.
 * No matching/rewrite of bundle source: minification must not affect this fixture. */
export function nativeQuestionClass(minify = false): any {
  const packageRoot = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
  const source = readFileSync(join(packageRoot, '@deepseek-ai/dsh-client-ui-user-questions/lib/client.js'), 'utf8')
  let factory: any
  runInNewContext(minify ? transformSync(source, { minify: true, target: 'esnext' }).code : source, {
    window: { __ModuleLoader__: { load(value: any) { factory = value.factory } } }, crypto: globalThis.crypto,
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Promise, AbortController, AbortSignal,
  })
  const store = (state: any) => ({ getSnapshot: () => state, update() {} })
  const plugin = factory(() => ({ createSnapshotStore: store, defineStore: (definition: any) => definition, createContext: () => ({}), memo: (value: any) => value }))
  let panels: any, pending: any
  plugin.apply({
    effect() {},
    uiSession: { registerPendingInteraction: () => (value: any) => { pending = value; return () => {} } },
    reflect: { provide: (name: string, value: any) => { if (name === 'userQuestionPanels') panels = value; return () => {} } },
    slots: { inject() {} }, uiConversation: { events: { register() {} } }, remote: { $on() {} },
  })
  panels.review('fixture-session', 'fixture-call', { questions: [], answers: [] })
  if (!pending) throw new Error('Native question panel did not publish a carrier')
  const constructor = pending.constructor
  pending.close()
  return constructor
}
