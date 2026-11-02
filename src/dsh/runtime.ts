import { realpathSync } from 'node:fs'
import { DshCoreRuntime, type DshRuntimeOptions } from './core-runtime.js'
import { DshContinuationRegistry, type DshContinuationBinding } from './agent-state.js'
import { KiokukoError } from '../errors.js'

export type * from './core-runtime.js'

/** A terminal decision for an exact-run resume request. */
export interface DshResumeDecision {
  readonly continue: boolean
  readonly runId: string | null
  readonly status: string | null
  readonly workspace: string
  readonly reason: string | null
  readonly warning: string | null
}

/** Compatibility runtime: exact run resume extends shared database ownership. */
export class DshRuntime extends DshCoreRuntime {
  readonly #continuations = new DshContinuationRegistry()
  constructor(private readonly options: DshRuntimeOptions) { super(options) }

  /** Resume only through the exact dsh session and canonical repository route. */
  async resume(input: { readonly dshSessionId: string; readonly cwd?: string; readonly runId?: string; readonly resumeToken?: string }): Promise<DshResumeDecision> {
    const cwd = realpathSync(this.options.repositoryRoot)
    const runId = input.runId
    if (runId === undefined) throw new KiokukoError('VALIDATION_ERROR', 'runId is required for exact dsh resume')
    if (input.resumeToken !== undefined) throw new KiokukoError('VALIDATION_ERROR', 'Orchestration resume tokens are no longer supported')
    const decision = await this.withDatabase((database) => {
      const row = database.prepare(`
        SELECT status, workspace
        FROM ledger_runs
        WHERE run_id = ? LIMIT 1
      `).get<{ status: string; workspace: string }>(runId)
      if (row === undefined) {
        return { continue: false, runId: null, status: null, workspace: '',
          reason: 'The resume run is not registered', warning: null }
      }
      return { continue: true, runId, status: row.status, workspace: row.workspace, reason: null, warning: null }
    })
    if (!decision.continue) throw new KiokukoError('CONFLICT', decision.reason ?? 'The run cannot be resumed from this repository')
    const binding: DshContinuationBinding = {
      resumeToken: `exact:${runId}`,
      dshSessionId: input.dshSessionId,
      runId,
      workspace: decision.workspace,
      routeEpoch: 0,
    }
    this.#continuations.bind(binding)
    return decision
  }

  get continuationCount(): number { return this.#continuations.size }
  override async close(): Promise<void> {
    this.#continuations.clear()
    await super.close()
  }
}
