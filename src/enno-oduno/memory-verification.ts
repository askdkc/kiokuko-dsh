import { canonicalContentHash } from '../serialization/validate.js'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { SqliteDatabase } from '../db/adapter.js'
import { beginMemoryExecution, completeMemoryExecution, type MemoryApplicationIdentity } from '../memory/application.js'
import { runVerifiers, type VerifierDependencies } from './verifier.js'
import type { VerifierSpec, VerifierRunResult } from './types.js'

/** Observe the existing approved host verifier; this creates no new process authority.
 * Memory failures withhold memory proof without changing real verification. */
export async function runMemoryAwareVerifiers(db: SqliteDatabase, runId: string, specs: readonly VerifierSpec[], root: string,
  dependencies: VerifierDependencies = {}): Promise<VerifierRunResult[]> {
  let identity: MemoryApplicationIdentity | undefined
  const calls: (string | null)[] = specs.map(() => null)
  try {
    const bound = db.prepare("SELECT 1 FROM sqlite_master WHERE name='task_memory_bindings'").get()
      ? db.prepare('SELECT workspace,session_id FROM task_memory_bindings WHERE run_id=?').get<{workspace:string;session_id:string}>(runId) : undefined
    if (bound) {
      identity = { runId, workspace: bound.workspace, sessionId: bound.session_id, repositoryRoot: root }
      const reviews = db.prepare(`SELECT r.review_json FROM task_memory_reviews r JOIN task_memory_bindings b ON b.run_id=r.run_id AND b.generation=r.generation
        WHERE r.run_id=? AND r.review_revision=(SELECT MAX(review_revision) FROM task_memory_reviews q WHERE q.run_id=r.run_id AND q.generation=r.generation AND q.entry_id=r.entry_id)`)
        .all<{review_json:string}>(runId).map(row => JSON.parse(row.review_json) as { command?: string; decision: string })
      for (const [index, spec] of specs.entries()) {
        const command = [spec.executable, ...spec.args].join(' ')
        if (path.resolve(root, spec.cwd) !== root || spec.args.some(arg => /[\s"'`$;&|<>\\]/u.test(arg))
          || !reviews.some(review => review.decision === 'adopted' && review.command === command)) continue
        try {
          const callId = `enno-verifier-${randomUUID()}`
          if (beginMemoryExecution(db, identity, callId, command)) calls[index] = callId
        } catch { /* Unavailable memory cannot prevent the approved verifier. */ }
      }
    }
  } catch { /* Missing, locked or corrupt memory is optional to verification. */ }
  const record = (index: number, result: unknown): void => {
    const callId = calls[index]
    if (!identity || !callId) return
    try { completeMemoryExecution(db, identity, callId, result) }
    catch { /* Failed persistence never changes the verifier outcome or claims saved proof. */ }
  }
  try {
    const results = await runVerifiers(specs, root, dependencies)
    for (const [index, result] of results.entries()) record(index, {
      isError: result.status !== 'passed' || result.changedDuringVerification === true,
      value: { invocationDigest: canonicalContentHash(result.verifier), exitCode: result.exitCode, signal: result.signal, skipped: result.skipped === true, timedOut: result.status === 'timeout' },
      content: [{ type: 'text', text: `${result.stdoutPreview}\n${result.stderrPreview}` }],
    })
    return results
  } catch (error) {
    for (const index of calls.keys()) record(index, { isError: true })
    throw error
  }
}
