import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { APPROVAL_CONFIG_SERVICE, type ApprovalConfigSource } from '../live-approval-config.js'
import type { ApprovalMode, LispApprovalPolicy } from './approval.js'

export const APPROVAL_NAMESPACE = 'kiokuko-lisp'
interface Settings {
  installSection?(owner: Context, namespace: string, schema: unknown, base: Record<string, ApprovalMode>, hooks: {
    setSource(source: () => Record<string, ApprovalMode>): void; onChange(): void
  }): void
  update(namespace: string, patch: object): Promise<unknown>
  readonly writable: boolean
}

/** One live profile source, independent of worker/session lifetime. */
export function mountApprovalPolicy(ctx: Context, base: ApprovalMode, validate: LispApprovalPolicy['validate']): LispApprovalPolicy {
  const filename = (ctx.get('loader', false) as { filename?: string } | undefined)?.filename
  // Native DSH stores settings across profiles in one document. Bind the saved
  // scalar to the loader-owned root config, never a session or model argument.
  const field = filename ? `approvalMode-${createHash('sha256').update(filename).digest('hex')}` : 'approvalMode'
  let current = (): Record<string, ApprovalMode> => ({ [field]: base })
  const schema = Schema.dict(Schema.union([Schema.const('ask'), Schema.const('auto')]))
  ctx.inject?.(['settings'], scope => {
    const settings = scope.get('settings') as Settings
    if (!settings.installSection) return
    settings.installSection(ctx, APPROVAL_NAMESPACE, schema, { [field]: base }, {
      setSource(source) { current = source }, onChange() {},
    })
  })
  const modern = () => !((ctx.get('settings', false) as Settings | undefined)?.installSection)
    ? ctx.get(APPROVAL_CONFIG_SERVICE, false) as ApprovalConfigSource | undefined : undefined
  return {
    mode: () => modern()?.mode() ?? current()[field] ?? base,
    validate,
    writable: () => { const settings = ctx.get('settings', false) as Settings | undefined; return settings?.writable === true && Boolean(settings.installSection || modern()) },
    async set(approvalMode) {
      const settings = ctx.get('settings', false) as Settings | undefined
      if (!settings?.writable) throw new Error('Persistent profile settings are unavailable or read-only.')
      const source = modern()
      if (!settings.installSection && !source) throw new Error('This host has no writable Lisp approval settings form.')
      const patch = source ? source.path.reduceRight<unknown>((value, key) => ({ [key]: value }), approvalMode) : { [field]: approvalMode }
      await settings.update(source?.namespace ?? APPROVAL_NAMESPACE, patch as object)
    },
  }
}
