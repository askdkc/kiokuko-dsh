import { randomUUID } from 'node:crypto'
import type { SqliteDatabase } from '../../db/adapter.js'
import type { DshCoreRuntime } from '../core-runtime.js'
import { applicationSourceDigest, beginMemoryExecution, completeMemoryExecution } from '../../memory/application.js'
import type { LispCiRequest } from './ci.js'
import type { LispOwner } from './contracts.js'

interface BoundRun extends Record<string, unknown> {
  run_id: string; workspace: string; delivery_id: string | null; generation: number; epoch: number
}
interface Preflight {
  runId: string; generation: number; epoch: number; deliveryId: string;
  reviewHash: string; sourceDigest: string
}

function binding(db: SqliteDatabase, owner: LispOwner): BoundRun | undefined {
  const rows = db.prepare(`SELECT b.run_id,b.workspace,b.delivery_id,b.generation,b.epoch
    FROM task_memory_bindings b JOIN ledger_runs r ON r.run_id=b.run_id
    WHERE b.session_id=? AND b.repository_root=? AND r.status='active' LIMIT 2`)
    .all<BoundRun>(owner.sessionId, owner.root)
  return rows.length === 1 ? rows[0] : undefined
}

function reviewBasis(db: SqliteDatabase, owner: LispOwner, runId: string, generation: number) {
  const rows = db.prepare('SELECT request_hash,review_json FROM task_memory_reviews WHERE run_id=? AND generation=? ORDER BY entry_id')
    .all<{request_hash:string;review_json:string}>(runId, generation)
  const adopted = rows.flatMap(row => {
    const review = JSON.parse(row.review_json) as {decision?:string;paths?:string[]}
    return review.decision === 'adopted' && Array.isArray(review.paths) ? [{hash:row.request_hash,paths:review.paths}] : []
  })
  return adopted.length ? {reviewHash:JSON.stringify(adopted.map(row => row.hash)),
    sourceDigest:applicationSourceDigest(owner.root, adopted.flatMap(row => row.paths))} : undefined
}

/** The CI result is host-owned; proof is admitted only after the separate eval commits without proposals. */
export function createLispMemoryVerification(runtime: Pick<DshCoreRuntime, 'withDatabase'>) {
  const preflights = new WeakMap<object, Preflight>()
  return {
    async beforeCall(owner: LispOwner, request: LispCiRequest): Promise<void> {
      // The Lisp API omits the default :workspace and "." values from its RPC.
      if (request.kind !== 'verify' || request.location === 'scratch' || request.directory !== undefined) return
      try {
        const preflight = await runtime.withDatabase(db => {
          const bound = binding(db, owner)
          if (!bound?.delivery_id) return undefined
          const basis = reviewBasis(db, owner, bound.run_id, bound.generation)
          return basis && {runId:bound.run_id,generation:bound.generation,epoch:bound.epoch,
            deliveryId:bound.delivery_id,...basis}
        })
        if (preflight) preflights.set(request, preflight)
      } catch { /* A failed preflight withholds proof without changing the CI adapter result. */ }
    },
    async afterEval(owner: LispOwner, operationId: string, generation: string, request: LispCiRequest, raw: unknown): Promise<void> {
      if (request.kind !== 'verify' || request.location === 'scratch' || request.directory !== undefined) return
      const result = raw as {state?:unknown;code?:unknown;script?:unknown;stdout?:unknown;stderr?:unknown}
      if (typeof result.script !== 'string' || !/^(?:test(?::[A-Za-z0-9._-]+)*|[A-Za-z0-9._-]+)$/u.test(result.script)) return
      if (result.state !== 'SUCCEEDED' && result.state !== 'FAILED') return
      const preflight = preflights.get(request)
      if (!preflight) return
      const command = result.script === 'test' ? 'npm test' : `npm run ${result.script}`
      await runtime.withDatabase(db => {
        const bound = binding(db, owner)
        if (!bound || bound.run_id !== preflight.runId || bound.generation !== preflight.generation
          || bound.epoch !== preflight.epoch || bound.delivery_id !== preflight.deliveryId) return
        const basis = reviewBasis(db, owner, bound.run_id, bound.generation)
        if (!basis || basis.reviewHash !== preflight.reviewHash || basis.sourceDigest !== preflight.sourceDigest) return
        const identity = {runId:bound.run_id, workspace:bound.workspace, sessionId:owner.sessionId, repositoryRoot:owner.root}
        const callId = `lisp-ci:${operationId}:${generation}:${randomUUID()}`
        beginMemoryExecution(db, identity, callId, command)
        completeMemoryExecution(db, identity, callId, {isError:result.state !== 'SUCCEEDED',
          value:{exitCode:result.code}, content:[{type:'text',text:`${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`}],
        })
      })
    },
  }
}
