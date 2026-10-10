import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

/** Expose the real private carrier from the pinned browser artifact for contract tests. */
export function nativeQuestionClass(): any {
  const packageRoot = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
  const source = readFileSync(join(packageRoot, '@deepseek-ai/dsh-client-ui-user-questions/lib/client.js'), 'utf8')
  let factory: any
  runInNewContext(source.replace('exports.apply = apply;', 'exports.PendingQuestion = PendingQuestion; exports.apply = apply;'), {
    window: { __ModuleLoader__: { load(value: any) { factory = value.factory } } }, crypto: globalThis.crypto,
    setTimeout, clearTimeout, Date, Promise, AbortController,
  })
  const store = (state: any) => ({ getSnapshot: () => state, update() {} })
  return factory(() => ({ createSnapshotStore: store, createContext: () => ({}), memo: (value: any) => value })).PendingQuestion
}
