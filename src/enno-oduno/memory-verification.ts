import { canonicalContentHash } from '../serialization/validate.js'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { SqliteDatabase } from '../db/adapter.js'
import { beginMemoryExecution, completeMemoryExecution } from '../memory/application.js'
import { runVerifiers, type VerifierDependencies } from './verifier.js'
import type { VerifierSpec, VerifierRunResult } from './types.js'

/** Observe the existing approved host verifier; this creates no new process authority. */
export async function runMemoryAwareVerifiers(db: SqliteDatabase, runId: string, specs: readonly VerifierSpec[], root: string,
  dependencies: VerifierDependencies = {}): Promise<VerifierRunResult[]> {
  const bound = db.prepare("SELECT 1 FROM sqlite_master WHERE name='task_memory_bindings'").get()
    ? db.prepare('SELECT workspace,session_id FROM task_memory_bindings WHERE run_id=?').get<{workspace:string;session_id:string}>(runId) : undefined
  if (!bound) return runVerifiers(specs, root, dependencies)
  const identity = { runId, workspace: bound.workspace, sessionId: bound.session_id, repositoryRoot: root }
  const reviews = db.prepare(`SELECT r.review_json FROM task_memory_reviews r JOIN task_memory_bindings b ON b.run_id=r.run_id AND b.generation=r.generation
    WHERE r.run_id=? AND r.review_revision=(SELECT MAX(review_revision) FROM task_memory_reviews q WHERE q.run_id=r.run_id AND q.generation=r.generation AND q.entry_id=r.entry_id)`)
    .all<{review_json:string}>(runId).map(row => JSON.parse(row.review_json) as { command?: string; decision: string })
  const calls: (string | null)[] = []
  try {
    for (const spec of specs) {
      const command = [spec.executable, ...spec.args].join(' ')
      if (path.resolve(root, spec.cwd) !== root || spec.args.some(arg => /[\s"'`$;&|<>\\]/u.test(arg)) || !reviews.some(review => review.decision === 'adopted' && review.command === command)) {
        calls.push(null)
        continue
      }
      const callId = `enno-verifier-${randomUUID()}`
      beginMemoryExecution(db, identity, callId, command)
      calls.push(callId)
    }
    const results = await runVerifiers(specs, root, dependencies)
    for (const [index, result] of results.entries()) {
      const callId = calls[index]
      if (callId) completeMemoryExecution(db, identity, callId, {
        isError: result.status !== 'passed' || result.changedDuringVerification === true,
        value: { invocationDigest: canonicalContentHash(result.verifier), exitCode: result.exitCode, signal: result.signal, skipped: result.skipped === true, timedOut: result.status === 'timeout' },
        content: [{ type: 'text', text: `${result.stdoutPreview}\n${result.stderrPreview}` }],
      })
    }
    return results
  } catch (error) {
    for (const callId of calls) if (callId) completeMemoryExecution(db, identity, callId, { isError: true })
    throw error
  }
}
