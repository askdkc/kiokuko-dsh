import { realpathSync } from 'node:fs'
import { DshCoreRuntime, type DshRuntimeOptions } from './core-runtime.js'
import { DshContinuationRegistry, type DshContinuationBinding } from './agent-state.js'
import { decideDshContinuation, type DshExactResumeExpectation, type DshResumeDecision } from './continuation.js'
import { KiokukoError } from '../errors.js'

export type * from './core-runtime.js'

/** Compatibility runtime: exact Enno continuation extends shared database ownership. */
export class DshRuntime extends DshCoreRuntime {
  readonly #continuations = new DshContinuationRegistry()
  constructor(private readonly options: DshRuntimeOptions) { super(options) }

  /** Resume only through the exact dsh session and canonical repository route. */
  async resume(input: { readonly dshSessionId: string; readonly cwd?: string; readonly runId?: string; readonly resumeToken?: string }): Promise<DshResumeDecision> {
    const cwd = realpathSync(this.options.repositoryRoot)
    const runId = input.runId
    if (runId === undefined) throw new KiokukoError('VALIDATION_ERROR', 'runId is required for exact dsh resume')
    const route = await this.withDatabase((database) => {
      const row = database.prepare(`
        SELECT ec.workspace AS workspace, ec.route_epoch AS routeEpoch,
               ec.dsh_session_id AS dshSessionId
        FROM enno_contracts AS ec
        JOIN ledger_runs AS lr ON lr.run_id = ec.run_id AND lr.workspace = ec.workspace
        WHERE ec.run_id = ? AND ec.repository_root = ?
      `).get<{
        workspace: string
        routeEpoch: number
        dshSessionId: string | null
      }>(runId, cwd)
      if (row === undefined) throw new KiokukoError('CONFLICT', 'The resume run is not registered for this repository')
      return row
    })
    const expectedRun: string | DshExactResumeExpectation = input.resumeToken === undefined
      ? runId
      : {
        runId,
        workspace: route.workspace,
        dshSessionId: input.dshSessionId,
        routeEpoch: route.routeEpoch,
        resumeToken: input.resumeToken,
        requireExistingBinding: true,
      }
    const decision = await this.withDatabase((database) => decideDshContinuation(database, {
      dshSessionId: input.dshSessionId,
      cwd,
    }, expectedRun))
    if (decision.runId !== null && decision.runId !== runId) throw new KiokukoError('CONFLICT', 'dsh resume resolved a different run')
    if (decision.resumeToken !== null && decision.runId !== null && decision.routeEpoch !== null && decision.directive !== null) {
      const workspace = await this.withDatabase((database) => {
        const row = database.prepare('SELECT workspace FROM ledger_runs WHERE run_id = ?').get<{ workspace: string }>(decision.runId!)
        if (row === undefined) throw new KiokukoError('CONFLICT', 'The resumed run is not registered')
        return row.workspace
      })
      const binding: DshContinuationBinding = {
        resumeToken: decision.resumeToken,
        dshSessionId: input.dshSessionId,
        runId: decision.runId,
        workspace,
        routeEpoch: decision.routeEpoch,
      }
      this.#continuations.bind(binding)
    }
    return decision
  }

  get continuationCount(): number { return this.#continuations.size }
  override async close(): Promise<void> {
    this.#continuations.clear()
    await super.close()
  }
}
