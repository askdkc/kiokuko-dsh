import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

/** Expose the real private carrier from the pinned browser artifact for contract tests. */
export function nativeQuestionClass(): any {
  const fixture = process.env.KIOKUKO_DSH_PACKAGE_ROOT?.includes('dsh-runtime-current') ? 'dsh-runtime-current' : 'dsh-runtime'
  const source = readFileSync(new URL(`../../fixtures/${fixture}/node_modules/@deepseek-ai/dsh-client-ui-user-questions/lib/client.js`, import.meta.url), 'utf8')
  let factory: any
  runInNewContext(source.replace('exports.apply = apply;', 'exports.PendingQuestion = PendingQuestion; exports.apply = apply;'), {
    window: { __ModuleLoader__: { load(value: any) { factory = value.factory } } }, crypto: globalThis.crypto,
    setTimeout, clearTimeout, Date, Promise, AbortController,
  })
  const store = (state: any) => ({ getSnapshot: () => state, update() {} })
  return factory(() => ({ createSnapshotStore: store, createContext: () => ({}), memo: (value: any) => value })).PendingQuestion
}
