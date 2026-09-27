import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ProposalRequest, digest, fail, type LispOwner, type ProposalInput } from './contracts.js'
import { sameFile, snapshot, type FileSnapshot } from './files.js'
import type { LispStore } from './store.js'

export const StageInput = z.object({ resultRef: z.uuid(), baseRef: z.uuid() }).strict()
export const ApplyInput = z.object({ candidateRef: z.uuid(), verificationRef: z.string().min(1).max(256).optional() }).strict()
export const VerifyInput = z.object({ candidateRef: z.uuid(), target: z.enum(['typecheck', 'lisp', 'test', 'build', 'package', 'vendor']),
  script: z.string().min(1).max(256).optional() }).strict()
export const CompareInput = z.object({ leftRef: z.uuid(), rightRef: z.uuid() }).strict()
export interface CandidatePayload {
  changes: ProposalInput[]; baseRef: string; resultRef: string;
  readSet: FileSnapshot[]; targets: Record<string, FileSnapshot>;
}

/** Freeze both observed inputs and targets before a candidate can be applied. */
export async function stageCandidate(owner: LispOwner, store: LispStore, data: CandidatePayload): Promise<{ candidateRef: string; changes: unknown[] }> {
  const ref = randomUUID()
  await store.reserve(owner, ref, 'task_candidate', digest(data), 'host', data)
  const changes = data.changes.map(change => ({ path: change.path, operation: change.operation,
    beforeHash: data.targets[change.path]?.hash ?? null,
    afterHash: change.operation === 'write' ? createHash('sha256').update(change.content).digest('hex') : null }))
  await store.transition(owner, ref, ['RUNNING'], 'STAGED', { candidateRef: ref, changes, verification: 'not-run' })
  return { candidateRef: ref, changes }
}

export async function candidateFromResult(owner: LispOwner, store: LispStore, resultRef: string, baseRef: string,
  protectedRoots: readonly string[]): Promise<CandidatePayload> {
  const resultRow = await store.get(owner, resultRef)
  const observation = await store.get(owner, baseRef)
  if (!resultRow || resultRow.kind !== 'task_result' || resultRow.state !== 'SUCCEEDED' || !resultRow.result
    || !observation || observation.kind !== 'task_result' || observation.state !== 'SUCCEEDED' || !observation.result)
    fail('TASK_RESULT_MISSING', '候補または観測結果がありません。')
  if ([resultRow, observation].some(row => Date.now() - Date.parse(row.updated_at) > 30 * 86400_000)) fail('TASK_RESULT_EXPIRED', '候補または観測結果の期限が切れました。')
  const metadata = JSON.parse(resultRow.payload) as { sourceRefs?: string[] }
  const origin = JSON.parse(observation.payload) as { source?: string; snapshots?: FileSnapshot[] }
  if (origin.source !== 'workspace.observe' || !origin.snapshots || !metadata.sourceRefs?.includes(baseRef))
    fail('CANDIDATE_ORIGIN', '候補の入力と指定された観測結果が対応していません。')
  const raw = (JSON.parse(resultRow.result) as { value: unknown }).value
  const observed = (JSON.parse(observation.result) as { value: unknown }).value
  if (digest(raw) !== resultRow.digest || digest(observed) !== observation.digest)
    fail('CANDIDATE_CORRUPT', '保存済みの候補または観測結果が変化しました。')
  const candidateValue = raw && typeof raw === 'object' && !Array.isArray(raw) && 'changes' in raw
    ? (raw as { changes: unknown }).changes : raw
  const changes = z.array(ProposalRequest).min(1).max(100).parse(candidateValue)
  if (new Set(changes.map(change => change.path)).size !== changes.length) fail('DUPLICATE_TARGET', '変更対象が重複しています。')
  const readSet = origin.snapshots
  for (const before of readSet) {
    const relative = before.path.slice(owner.root.length + 1)
    if (!sameFile(before, await snapshot(owner.root, relative, protectedRoots))) fail('BASE_CHANGED', '観測した入力が変わりました。')
  }
  const targets: Record<string, FileSnapshot> = {}
  for (const change of changes) targets[change.path] = await snapshot(owner.root, change.path, protectedRoots)
  return { changes, resultRef, baseRef, readSet, targets }
}

export async function loadCandidate(owner: LispOwner, store: LispStore, ref: string): Promise<CandidatePayload> {
  const { data, state } = await inspectCandidate(owner, store, ref)
  if (state !== 'STAGED') fail('CANDIDATE_ALREADY_USED', '候補はすでに適用処理へ進んでいます。')
  return data
}

export async function inspectCandidate(owner: LispOwner, store: LispStore, ref: string): Promise<{ data: CandidatePayload; state: string }> {
  const row = await store.get(owner, z.uuid().parse(ref))
  if (!row || row.kind !== 'task_candidate' || !row.result) fail('CANDIDATE_MISSING', '候補がありません。')
  if (Date.now() - Date.parse(row.updated_at) > 30 * 86400_000) fail('CANDIDATE_EXPIRED', '候補の期限が切れました。')
  const data = JSON.parse(row.payload) as CandidatePayload
  if (digest(data) !== row.digest) fail('CANDIDATE_CORRUPT', '候補の内容が変化しました。')
  return { data, state: row.state }
}

/** Compare immutable candidate intent without reading current workspace files or claiming execution. */
export async function compareCandidates(owner: LispOwner, store: LispStore, leftRef: string, rightRef: string) {
  const left = await inspectCandidate(owner, store, leftRef), right = await inspectCandidate(owner, store, rightRef)
  const index = (data: CandidatePayload) => new Map(data.changes.map(change => [change.path, {
    operation: change.operation, afterHash: change.operation === 'write' ? createHash('sha256').update(change.content).digest('hex') : null,
  }]))
  const a = index(left.data), b = index(right.data)
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort()
  return { left: { ref: leftRef, state: left.state }, right: { ref: rightRef, state: right.state },
    sameBase: left.data.baseRef === right.data.baseRef && digest(left.data.readSet) === digest(right.data.readSet),
    changes: paths.map(path => ({ path, left: a.get(path) ?? null, right: b.get(path) ?? null,
      same: digest(a.get(path) ?? null) === digest(b.get(path) ?? null) })) }
}

/** A receipt is evidence only for the exact immutable candidate and a known successful command exit. */
export async function loadVerification(owner: LispOwner, store: LispStore, ref: string, candidateRef: string,
  candidate: CandidatePayload): Promise<unknown> {
  const row = await store.get(owner, ref)
  if (!row || row.kind !== 'lisp_verify' || row.state !== 'SUCCEEDED' || !row.result)
    fail('VERIFICATION_MISSING', '検証receiptがありません。')
  const recorded = JSON.parse(row.result) as { candidateRef?: string; candidateDigest?: string;
    execution?: { state?: string; code?: number }; testStatus?: string }
  if (recorded.candidateRef !== candidateRef || recorded.candidateDigest !== digest(candidate))
    fail('VERIFICATION_MISMATCH', '検証した候補と適用する候補が異なります。')
  if (recorded.execution?.state !== 'SUCCEEDED' || recorded.execution.code !== 0)
    fail('VERIFICATION_NOT_PASSED', '検証コマンドは成功していません。')
  return { operationId: ref, commandState: recorded.execution.state, testStatus: recorded.testStatus ?? 'unknown' }
}

/** Materialize only the declared observation plus candidate into a private scratch project. */
export async function materializeCandidate(owner: LispOwner, store: LispStore, candidate: CandidatePayload, dataRoot: string): Promise<string> {
  const observation = await store.get(owner, candidate.baseRef)
  if (!observation || observation.kind !== 'task_result' || !observation.result) fail('CANDIDATE_ORIGIN', '観測結果がありません。')
  const value = (JSON.parse(observation.result) as { value?: { items?: Array<{ path: string; digest: string }> } }).value
  const frozen = (JSON.parse(observation.payload) as { frozenBytes?: Array<{ path: string; digest: string; base64: string }> }).frozenBytes
  if (!value || !Array.isArray(value.items)) fail('CANDIDATE_ORIGIN', '観測結果が壊れています。')
  if (digest(value) !== observation.digest || !Array.isArray(frozen) || frozen.length !== value.items.length)
    fail('CANDIDATE_CORRUPT', '観測済み入力の保存内容が一致しません。')
  const root = await mkdtemp(join(dataRoot, 'candidate-'))
  try {
    for (const [index, item] of value.items.entries()) {
      const saved = frozen[index]!
      const source = candidate.readSet.find(entry => entry.path === join(owner.root, item.path))
      if (!source || !source.exists || source.hash !== item.digest || saved.path !== item.path || saved.digest !== item.digest)
        fail('CANDIDATE_ORIGIN', '観測範囲が一致しません。')
      const bytes = Buffer.from(saved.base64, 'base64')
      if (createHash('sha256').update(bytes).digest('hex') !== item.digest) fail('CANDIDATE_CORRUPT', '観測済み入力のbytesが変化しました。')
      const target = join(root, item.path)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 })
    }
    for (const change of candidate.changes) {
      const target = join(root, change.path)
      if (change.operation === 'delete') {
        try { await unlink(target) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      } else {
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await writeFile(target, change.content, { mode: 0o600 })
      }
    }
    if (!await readFile(join(root, 'package.json'), 'utf8').catch(() => null)) fail('VERIFIER_PROJECT_MISSING', '検証には観測済みの package.json が必要です。')
    return root
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error }
}
