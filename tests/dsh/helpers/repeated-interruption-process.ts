import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { repeatedNativeHost } from './repeated-memory-native.js'
import { deepNativeFixture } from './deep-native-fixture.js'
import { deepRoundScript, completeDeepRound } from './repeated-deep-native.js'
import type { FinalizationInputMode } from '../../../src/dsh/efficiency.js'

const [root, kind, mode, value] = process.argv.slice(2)
if (!root || !['deep','evolution'].includes(kind!)) throw new Error('Invalid interruption fixture')
const round = Number(value)
// Only the disposable child clock advances. Real timers remain bounded, while
// a persisted lease can expire without a fixed wall-clock sleep in the test.
const realNow = Date.now
if (round === 3) Date.now = () => realNow() + 120_000
if (kind === 'deep') {
  const f = await deepNativeFixture(mock => {
    const script = deepRoundScript(mock, round)
    if (round === 2) script[2] = async function* () {
      const attempt = await f.deep.store.database(db => db.prepare("SELECT a.run_id,a.attempt_id,r.reservation_id FROM dsh_deep_attempts a JOIN dsh_deep_budget_reservations r USING(attempt_id) WHERE a.status='started' AND r.status='reserved' AND r.kind='agent' ORDER BY r.created_at DESC LIMIT 1").get<{run_id:string;attempt_id:string;reservation_id:string}>())
      assert.ok(attempt?.reservation_id, 'native model dispatch must have a durable reservation')
      process.send?.({ kind: 'dispatched', runId: attempt.run_id, jobId: attempt.attempt_id })
      await new Promise(() => {})
    }
    return script
  }, { root, dataRoot: join(root,'.git','deep-state'), keepFiles: true, sessionId: `deep-interrupted-${round}` })
  try { await writeFile(join(root,'.git',`interruption-${round}.json`), JSON.stringify(await completeDeepRound(f, round))) }
  finally { await f.close() }
} else {
  const host = await repeatedNativeHost(root, mode as FinalizationInputMode, 'normal', { now: () => new Date(Date.now()).toISOString() })
  try {
    if (round === 1) await host.round(1, 'interruption-prelude', false, false)
    if (round === 2) host.setAuxiliaryHook(async request => {
      if (!request.system?.startsWith('Select a conservative reusable lesson')) return
      const job = await host.database(db => db.prepare("SELECT j.id,j.trigger_run FROM memory_evolution_jobs j JOIN memory_evolution_calls c ON c.job_id=j.id WHERE j.state='processing'").get<{id:string;trigger_run:string}>())
      assert.ok(job, 'evolution dispatch must already be durable')
      process.send?.({ kind: 'dispatched', runId: job.trigger_run, jobId: job.id })
      await new Promise(() => {})
    })
    const report = await host.round(round + 1, `interrupted-session-${round}`, false, false)
    await writeFile(join(root,'.git',`interruption-${round}.json`), JSON.stringify(report))
  } finally { await host.close() }
}
