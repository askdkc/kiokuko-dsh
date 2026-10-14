import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, openSync, closeSync, fstatSync, constants } from 'node:fs'
import path from 'node:path'
import type { SqliteDatabase } from '../../db/adapter.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import { isHostExecutionResult, type HostProcessResult } from '../execution-result.js'
import { authorizeTaskLease, recordTaskEvidence } from '../task-state.js'
import type { ExecutionReceipt } from '../owned-execution.js'
import { PROTOCOL_ISSUER, type Manifest, type ProtocolObservation, type ProtocolReceipt, type ProtocolState } from './contracts.js'
export const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export function manifest(root: string, paths: readonly string[]): Manifest {
  if (realpathSync(root) !== root || paths.length > 64) throw Error('Protocol source root/manifest is invalid')
  const result: Manifest = {}; let bytes = 0
  for (const relative of [...paths].sort()) {
    if (path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Protocol path escapes its scope')
    let current = root
    for (const [index, part] of relative.split('/').entries()) {
      current = path.join(current, part)
      let st
      try { st = lstatSync(current) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { if (index !== relative.split('/').length - 1) throw Error('Create protocol parent directories before binding'); result[relative] = null; break } throw error }
      if (st.isSymbolicLink()) throw Error('Protocol paths cannot contain symlinks')
      if (index < relative.split('/').length - 1) { if (!st.isDirectory()) throw Error('Protocol parent is not a directory'); continue }
      if (!st.isFile() || st.nlink !== 1 || st.size > 8 * 1024 * 1024) throw Error('Protocol input must be a bounded regular single-link file')
      const fd = openSync(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const actual = fstatSync(fd)
        if (actual.dev !== st.dev || actual.ino !== st.ino || !actual.isFile() || actual.nlink !== 1) throw Error('Protocol source changed while opening')
        const data = readFileSync(fd); bytes += data.length
        if (bytes > 64 * 1024 * 1024) throw Error('Protocol manifest byte limit')
        result[relative] = canonicalContentHash({bytes:sha(data),mode:actual.mode & 0o7777})
      } finally { closeSync(fd) }
    }
  }
  return result
}
export const manifestDigest = (value: Manifest) => canonicalContentHash(value)
export const equalManifest = (a: Manifest, b: Manifest) => manifestDigest(a) === manifestDigest(b)
const structured = new WeakMap<object, ProtocolObservation>()
const uncertainResults = new WeakSet<object>()
export function markUncertainProtocolResult(result:HostProcessResult):void {if(!isHostExecutionResult(result))throw Error('Missing host result identity');uncertainResults.add(result)}
export function protocolReceiptUncertain(receipt:ExecutionReceipt):boolean {const result=processResults.get(receipt);return !!result&&uncertainResults.has(result)}
const processResults = new WeakMap<object, HostProcessResult>()
/** Only the host runner calls this. There is no tool or JSON registration path. */
export function registerStructuredObservation(result: HostProcessResult, observation: ProtocolObservation): void { if (!isHostExecutionResult(result)) throw Error('Missing host result identity'); structured.set(result, Object.freeze({...observation})) }
export function retainProtocolResult(receipt: ExecutionReceipt, result: HostProcessResult): void { if (isHostExecutionResult(result)) processResults.set(receipt, result) }
export function issueProtocolReceipt(db: SqliteDatabase, state: ProtocolState, receipt: ExecutionReceipt, runtimeDigest: string): ProtocolReceipt {
  authorizeTaskLease(db, state.lease)
  const result = processResults.get(receipt), observation = result && structured.get(result)
  const stored = db.prepare("SELECT receipt_json FROM dsh_owned_operations WHERE operation_id=? AND run_id=? AND state='completed'").get<{receipt_json:string}>(receipt.operationId, state.lease.taskId)
  if (!stored || !result || !observation || canonicalContentHash(JSON.parse(stored.receipt_json)) !== canonicalContentHash(receipt as any) || receipt.authority !== 'current' || receipt.taskAuthority?.revision !== state.lease.revision || receipt.taskAuthority?.generation !== state.lease.generation) throw Error('Protocol receipt lacks current host-owned provenance')
  if (observation.operationId !== receipt.operationId || observation.runtimeDigest !== runtimeDigest || runtimeDigest !== state.runtimeDigest || !observation.complete || !result.value.outputComplete || !result.value.processStarted || result.value.timedOut || result.value.aborted || result.value.signal !== null) throw Error('Protocol test observation is incomplete, cancelled or stale')
  if (!equalManifest(state.source, manifest(state.lease.repositoryRoot, state.sourcePaths)) || !equalManifest(state.tests, manifest(state.lease.repositoryRoot, state.recipe.testPaths))) throw Error('Protocol source/tests changed during test execution; explicitly amend the unit')
  const eligible = observation.explicit > 0 && observation.tests > 0 && observation.skipped === 0 && observation.todo === 0 && observation.cancelled === 0 && observation.otherFailures === 0
  const outcome = eligible && observation.failed > 0 && observation.assertionFailures === observation.failed && result.value.exitCode === 1 ? 'assertion-failure'
    : eligible && observation.failed === 0 && observation.passed === observation.tests && result.value.exitCode === 0 ? 'passed' : 'setup-error'
  const value = { issuer: PROTOCOL_ISSUER, id: receipt.operationId, task: {...state.lease}, recipeId: state.recipeId, generation: state.generation,
    sourceDigest: manifestDigest(state.source), testDigest: manifestDigest(state.tests), commandDigest: sha(state.command), runtimeDigest,
    environmentDigest: observation.environmentDigest, ownedReceiptDigest: canonicalContentHash(receipt as any), observationDigest: canonicalContentHash(observation as any), outputDigest: sha(result.content.map(block=>block.text).join('\n')), outcome, assertions: outcome === 'assertion-failure' ? observation.assertionFailures : outcome === 'passed' ? observation.passed : 0, exit: result.value.exitCode ?? 70 } as const
  const proof: ProtocolReceipt = {...value,digest:canonicalContentHash(value as any)}
  recordTaskEvidence(db, state.lease, {ref:`protocol-observation:${proof.id}`,kind:'verification',generation:state.lease.generation,verified:false,details:proof as any})
  return proof
}
export function validateProtocolReceipt(db: SqliteDatabase, state: ProtocolState, receipt: ProtocolReceipt): void {
  authorizeTaskLease(db, state.lease)
  const {digest,...body}=receipt
  const witness=db.prepare("SELECT details_json FROM ledger_task_evidence WHERE run_id=? AND evidence_ref=? AND generation=? AND verified=0 AND kind='verification'").get<{details_json:string}>(state.lease.taskId,`protocol-observation:${receipt.id}`,state.lease.generation)
  const owned=db.prepare("SELECT receipt_json FROM dsh_owned_operations WHERE operation_id=? AND run_id=? AND state='completed'").get<{receipt_json:string}>(receipt.id,state.lease.taskId)
  if(!owned||canonicalContentHash(JSON.parse(owned.receipt_json))!==receipt.ownedReceiptDigest||receipt.issuer!==PROTOCOL_ISSUER || receipt.runtimeDigest!==state.runtimeDigest || receipt.recipeId!==state.recipeId || receipt.generation!==state.generation || canonicalContentHash(receipt.task as any)!==canonicalContentHash(state.lease as any) || receipt.commandDigest!==sha(state.command) || receipt.testDigest!==manifestDigest(state.tests) || digest!==canonicalContentHash(body as any) || !witness || canonicalContentHash(JSON.parse(witness.details_json))!==canonicalContentHash(receipt as any)) throw Error('Protocol receipt issuer, task, revision, generation or binding is invalid')
}
