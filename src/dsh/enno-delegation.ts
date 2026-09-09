import { AsyncLocalStorage } from 'node:async_hooks'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { canonicalContentHash } from '../serialization/validate.js'
import { KiokukoError } from '../errors.js'
import { findSecretInValue } from '../memory/secrets.js'
import { ModelBindingSchema, type ModelBinding } from './model-configuration.js'
import type { RoutableAgent } from './model-routing.js'
import type { DshRuntime } from './runtime.js'
import type { DshToolHostBinding } from './tools.js'
import { assertExecutionLeaseInTransaction, readEnnoSnapshot } from '../enno-oduno/store.js'
import { readExecutionSelection } from './execution-selection.js'
import { withImmediateTransaction } from '../db/transaction.js'

export interface DshSpawnBackend {
  start(name: 'spawn', request: {
    parent: RoutableAgent; prompt: { type: 'text'; text: string }[]; signal: AbortSignal;
    agentOptions: ModelBinding; maxDepth: number; toolFilter: { allow: readonly string[] }; label: string;
  }): Promise<{ readonly id: string; readonly localAgent?: RoutableAgent; result: Promise<{ output: unknown; stopReason: string }>; dispose(): Promise<void> }>
}
interface ChildBinding { readonly runId: string; readonly parent?: RoutableAgent; readonly parentSessionId: string; readonly model: ModelBinding; readonly toolNames: readonly string[]; readonly root: string; readonly scope: readonly string[]; readonly delegationId: string; child?: RoutableAgent }
const CHILD_FILE_TOOLS = new Set(['read', 'write', 'edit', 'multiedit', 'str_replace_editor', 'glob', 'grep', 'skill'])
/** Child shells/custom execution tools cannot enforce a WorkUnit file boundary.
 * The Goki head owns commands and final focused verification in this version. */
export function childFileScopeDenial(root: string, scope: readonly string[], name: string, args: unknown): string | undefined {
  if (!CHILD_FILE_TOOLS.has(name)) return 'Goki children use scoped file tools; the head runs commands and verifiers'
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'Invalid child tool arguments'
  const fields = args as Record<string, unknown>
  const supplied = fields.file_path ?? fields.filePath ?? fields.path
  if (name === 'skill') return undefined
  if (typeof supplied !== 'string') return ['glob', 'grep'].includes(name) ? undefined : 'A child file operation requires an explicit repository path'
  const absolute = path.resolve(root, supplied)
  let ancestor = absolute
  let canonicalTarget = absolute
  while (true) {
    try { const canonical = realpathSync(ancestor); const relative = path.relative(root, canonical); if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return 'Child path leaves the canonical repository'; canonicalTarget = path.resolve(canonical, path.relative(ancestor, absolute)); break }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'Cannot verify the child path'; const parent = path.dirname(ancestor); if (parent === ancestor) return 'Cannot verify the child path'; ancestor = parent }
  }
  const relative = path.relative(root, absolute)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return 'Child path leaves the canonical repository'
  const mutating = ['write', 'edit', 'multiedit'].includes(name) || name === 'str_replace_editor' && fields.command !== 'view'
  if (mutating && ![relative, path.relative(root, canonicalTarget)].every(target => scope.some(entry => entry === '.' || target === entry || target.startsWith(`${entry}${path.sep}`) || path.matchesGlob(target, entry)))) return 'Child mutation is outside the approved WorkUnit scope'
  return undefined
}
const instructionSchema = z.object({ instruction: z.string().trim().min(1).max(16_384) }).strict()
const authoritySchema = z.object({
  runId: z.string(), workspace: z.string(), orchestrationId: z.string(),
  revision: z.number().int(), routeEpoch: z.number().int(), leaseToken: z.string(), workUnitId: z.string(),
}).strict()
export class DshEnnoDelegation {
  readonly #pending = new AsyncLocalStorage<ChildBinding>()
  readonly #children = new WeakMap<object, ChildBinding>()
  constructor(private readonly runtime: Pick<DshRuntime, 'withDatabase'>, private readonly backend: DshSpawnBackend | undefined) {}
  /** Called synchronously at agent/created, before session-start and followup. */
  created(agent: RoutableAgent): void {
    const binding = this.#pending.getStore()
    if (!binding || binding.child) return
    binding.child = agent
    this.#children.set(agent, binding)
  }
  model(agent: object): ModelBinding | undefined { return this.#children.get(agent)?.model }
  isChild(agent: object): boolean { return this.#children.has(agent) }
  parent(agent: object): RoutableAgent | undefined { return this.#children.get(agent)?.parent }
  observationBinding(agent: object): { runId: string; parentSessionId: string } | undefined {
    const binding = this.#children.get(agent)
    return binding === undefined ? undefined : { runId: binding.runId, parentSessionId: binding.parentSessionId }
  }
  allows(agent: object, tool: string): boolean { return this.#children.get(agent)?.toolNames.includes(tool) ?? true }
  toolDenial(agent: object, name: string, args: unknown): string | undefined {
    const binding = this.#children.get(agent)
    if (!binding) return undefined
    if (!binding.toolNames.includes(name)) return 'Tool is outside the delegated scope'
    return childFileScopeDenial(binding.root, binding.scope, name, args)
  }
  /** Durable ownership is checked again before every child request and tool,
   * including after reload. Completing or replacing a lease revokes the child. */
  async assertCurrent(agent: object): Promise<void> {
    const binding = this.#children.get(agent)
    if (!binding) return
    await this.runtime.withDatabase(db => {
      const row = db.prepare('SELECT authority_json, status FROM dsh_enno_delegations WHERE delegation_id = ?')
        .get<{ authority_json: string; status: string }>(binding.delegationId)
      if (!row || row.status !== 'started') throw new KiokukoError('CONFLICT', 'The delegated execution is no longer active')
      const authority = authoritySchema.parse(JSON.parse(row.authority_json))
      const snapshot = readEnnoSnapshot(db, authority)
      if (snapshot.status !== 'goki_executing' || snapshot.revision !== authority.revision || snapshot.dshSessionId !== binding.parentSessionId) throw new KiokukoError('CONFLICT', 'The delegated WorkUnit authority is stale')
      assertExecutionLeaseInTransaction(db, snapshot, authority)
    })
  }
  /** Persist the created binding before the child's first request; restore only
   * by its exact durable child id, never by origin/parent metadata alone. */
  async restoreOrPersist(agent: RoutableAgent): Promise<ModelBinding | undefined> {
    const live = this.#children.get(agent)
    if (live) {
      await this.runtime.withDatabase(db => db.prepare('UPDATE dsh_enno_delegations SET child_session_id = ? WHERE delegation_id = ? AND (child_session_id IS NULL OR child_session_id = ?)')
        .run(agent.session?.id ?? agent.id, live.delegationId, agent.session?.id ?? agent.id))
      return live.model
    }
    const stored = await this.runtime.withDatabase(db => db.prepare('SELECT delegation_id, run_id, parent_session_id, model_json, tools_json, repository_root, scope_json FROM dsh_enno_delegations WHERE child_session_id = ?')
      .get<{ delegation_id: string; run_id: string; parent_session_id: string; model_json: string; tools_json: string; repository_root: string; scope_json: string }>(agent.session?.id ?? agent.id))
    if (!stored) return undefined
    const model = ModelBindingSchema.parse(JSON.parse(stored.model_json))
    const toolNames = z.array(z.string()).parse(JSON.parse(stored.tools_json))
    this.#children.set(agent, { runId: stored.run_id, model, toolNames, root: stored.repository_root, scope: z.array(z.string()).parse(JSON.parse(stored.scope_json)), delegationId: stored.delegation_id, parentSessionId: stored.parent_session_id, child: agent })
    return model
  }
  async execute(parent: RoutableAgent, args: unknown, binding: DshToolHostBinding, toolNames: readonly string[], signal: AbortSignal): Promise<unknown> {
    const input = instructionSchema.parse(args)
    const allowedTools = toolNames.filter(name => CHILD_FILE_TOOLS.has(name))
    if (this.isChild(parent) || !this.backend) throw new KiokukoError('SERVICE_UNAVAILABLE', 'Native spawn delegation is unavailable; grandchildren are prohibited')
    const admitted = await this.runtime.withDatabase(db => withImmediateTransaction(db, () => {
      const snapshot = readEnnoSnapshot(db, binding)
      if (snapshot.status !== 'goki_executing' || snapshot.revision !== binding.revision || snapshot.dshSessionId !== parent.session?.id || !binding.workUnitId || !binding.leaseToken) throw new KiokukoError('CONFLICT', 'Delegation requires the current approved WorkUnit')
      assertExecutionLeaseInTransaction(db, snapshot, { workUnitId: binding.workUnitId, leaseToken: binding.leaseToken, routeEpoch: binding.routeEpoch })
      const selection = readExecutionSelection(db, binding.runId)?.value
      if (selection?.mode !== 'enno' || selection.status !== 'ready' || !selection.configuration) throw new KiokukoError('CONFLICT', 'Choose the worker model before delegation')
      const unit = snapshot.workUnits.find(u => u.workUnit.id === binding.workUnitId)?.workUnit
      if (!unit) throw new KiokukoError('CONFLICT', 'WorkUnit is unavailable')
      const digest = canonicalContentHash({ input, revision: binding.revision, workUnit: unit, model: selection.configuration.roles.worker })
      const previous = db.prepare('SELECT input_digest, status, result_json FROM dsh_enno_delegations WHERE delegation_id = ?')
        .get<{ input_digest: string; status: string; result_json: string | null }>(binding.idempotencyKey)
      if (previous) {
        if (previous.input_digest !== digest) throw new KiokukoError('CONFLICT', 'Delegation input changed under the same call identity')
        if (previous.status === 'completed' && previous.result_json) return { replay: JSON.parse(previous.result_json) as unknown }
        throw new KiokukoError('CONFLICT', 'A previous delegation may have executed; inspect its child evidence before issuing new work')
      }
      const active = db.prepare("SELECT COUNT(*) AS count FROM dsh_enno_delegations WHERE run_id = ? AND status = 'started'").get<{ count: number }>(binding.runId)?.count ?? 0
      if (active >= selection.configuration.maxConcurrentChildren) throw new KiokukoError('CONFLICT', 'Child concurrency limit reached; wait for or inspect the existing child')
      const authority = authoritySchema.parse({ runId: binding.runId, workspace: binding.workspace, orchestrationId: binding.orchestrationId, revision: binding.revision, routeEpoch: binding.routeEpoch, leaseToken: binding.leaseToken, workUnitId: binding.workUnitId })
      db.prepare("INSERT INTO dsh_enno_delegations (delegation_id, run_id, input_digest, status, parent_session_id, model_json, tools_json, repository_root, scope_json, authority_json) VALUES (?, ?, ?, 'started', ?, ?, ?, ?, ?, ?)")
        .run(binding.idempotencyKey, binding.runId, digest, parent.session!.id, JSON.stringify(selection.configuration.roles.worker), JSON.stringify(allowedTools), snapshot.repositoryRoot, JSON.stringify(unit.scope), JSON.stringify(authority))
      return { model: selection.configuration.roles.worker, unit, root: snapshot.repositoryRoot }
    }))
    if ('replay' in admitted) return admitted.replay
    const childBinding: ChildBinding = { runId: binding.runId, parent, parentSessionId: parent.session!.id, toolNames: allowedTools, root: admitted.root, scope: admitted.unit.scope, model: admitted.model, delegationId: binding.idempotencyKey }
    let run: Awaited<ReturnType<DshSpawnBackend['start']>> | undefined
    try {
      run = await this.#pending.run(childBinding, () => this.backend!.start('spawn', {
        parent, signal, agentOptions: { ...admitted.model }, maxDepth: 1, label: 'Goki worker',
        toolFilter: { allow: allowedTools },
        prompt: [{ type: 'text', text: [
          'You are the Goki worker for one approved WorkUnit. Do not start Kiokuko intake, ask for orchestration selection, delegate, or report acceptance. You have no parent run or lease authority. Preserve other work. Stay within the declared scope. Return changed paths, verification evidence and unresolved issues to Goki.',
          JSON.stringify({ objective: admitted.unit.objective, scope: admitted.unit.scope, acceptanceCriteria: admitted.unit.acceptanceCriteria, instruction: input.instruction }),
        ].join('\n') }],
      }))
      if (!run.localAgent || childBinding.child !== run.localAgent || !this.isChild(run.localAgent)) throw new KiokukoError('INTEGRITY_ERROR', 'Spawn did not establish the exact managed child before first execution')
      const child = await run.result
      if (findSecretInValue(child.output) !== undefined) throw new KiokukoError('SECURITY_REJECTION', 'Child output contains secret-shaped content and was not persisted or forwarded')
      const result = { childSessionId: run.id, stopReason: child.stopReason, output: child.output, accepted: false,
        instruction: 'Goki must review this evidence and run the WorkUnit verifier before enno_work_report.' }
      const json = JSON.stringify(result)
      if (Buffer.byteLength(json) > 256 * 1024) throw new KiokukoError('VALIDATION_ERROR', 'Child output exceeds the delegation result limit; inspect the native child session')
      await this.runtime.withDatabase(db => db.prepare("UPDATE dsh_enno_delegations SET status = 'completed', result_json = ? WHERE delegation_id = ?").run(json, binding.idempotencyKey))
      return result
    } catch (error) {
      await this.runtime.withDatabase(db => db.prepare("UPDATE dsh_enno_delegations SET status = 'uncertain' WHERE delegation_id = ? AND status = 'started'").run(binding.idempotencyKey))
      throw error
    } finally {
      await run?.dispose()
    }
  }
}
