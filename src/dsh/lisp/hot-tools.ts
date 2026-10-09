import { randomUUID } from 'node:crypto'
import type { DshUserQuestions } from '../user-interaction.js'
import { confirm } from './approval.js'
import { digest, fail, failure, LispError, type LispOwner, type LispTool } from './contracts.js'
import { HotCallInput, HotDeactivateInput, HotInstallInput, HotStatusInput, parseHotContract } from './hot-contracts.js'
import { HotToolStore } from './hot-store.js'
import { LispStore } from './store.js'
import { TaskToolCatalog, selectFields, validateValue } from './task-tools.js'

export type HotMutation = Extract<LispTool, 'lisp_hot_contract' | 'lisp_hot_install' | 'lisp_hot_call' | 'lisp_hot_deactivate'>
interface ExecutionResult { value: unknown; output: unknown; generation: string }
interface HotOptions {
  store: LispStore
  questions?: DshUserQuestions
  projectRoot(owner: LispOwner): Promise<string>
  authorize(owner: LispOwner): Promise<void>
  run(owner: LispOwner, source: string, input: unknown, signal: AbortSignal, mode?: 'call' | 'compile'): Promise<ExecutionResult>
  input(owner: LispOwner, resultRef: string): Promise<unknown>
}
interface Scope { projectRoot: string; epoch: string }

/** Share immutable code; all dispatch, input refs and receipts retain the caller's owner. */
export class HotToolRuntime {
  readonly catalog: HotToolStore
  readonly #active = new Map<AbortController, string>()
  constructor(private readonly options: HotOptions) { this.catalog = new HotToolStore(options.store) }

  cancel(sessionId?: string): void {
    for (const [controller, session] of this.#active) if (sessionId === undefined || sessionId === session)
      controller.abort(new LispError('CANCELLED', '名前付き関数の処理を取り消しました。'))
  }

  private async scope(owner: LispOwner, signal?: AbortSignal, expected?: Scope): Promise<Scope> {
    signal?.throwIfAborted()
    await this.options.authorize(owner)
    const session = await this.options.store.session(owner.sessionId)
    if (!session?.enabled || session.root_path !== owner.root) fail('HOT_SCOPE', '有効なセッションと作業場所が必要です。')
    const projectRoot = await this.options.projectRoot(owner)
    signal?.throwIfAborted()
    if (expected && (session.epoch !== expected.epoch || projectRoot !== expected.projectRoot))
      fail('HOT_SCOPE', '検証中にセッション世代またはプロジェクトが変わりました。')
    return { projectRoot, epoch: session.epoch }
  }

  async status(owner: LispOwner, input: unknown = {}): Promise<unknown> {
    const request = HotStatusInput.parse(input)
    const scope = await this.scope(owner)
    const heads = await this.catalog.status(scope.projectRoot, request.name, request.offset), tools = heads.slice(0, 10)
    const selected = request.name ? tools.find(tool => tool.name === request.name) : undefined
    const contract = selected?.contractRef ? await this.catalog.contract(scope.projectRoot, selected.contractRef, request.name) : undefined
    if (contract && request.contractOffset !== undefined) {
      const characters = Array.from(JSON.stringify(contract)), offset = request.contractOffset
      return { ok: true, projectRoot: scope.projectRoot, contractRef: contract.contractRef, offset,
        totalCharacters: characters.length, nextOffset: offset + 2000 < characters.length ? offset + 2000 : null,
        text: characters.slice(offset, offset + 2000).join('') }
    }
    return { ok: true, projectRoot: scope.projectRoot, tools, offset: request.offset, nextOffset: heads.length > 10 ? request.offset + 10 : null,
      ...(contract ? { contract, inspect: { tool: 'lisp_hot_status', name: request.name, contractOffset: 0 } } : {}),
      recovery: '/kioku-lisp diagnostics OPERATION_ID / recover; interrupted operations are never rerun automatically.' }
  }

  async execute(owner: LispOwner, tool: HotMutation, id: string, hash: string, raw: unknown, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController()
    this.#active.set(controller, owner.sessionId)
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    try {
      const scope = await this.scope(owner, combined)
      if (tool === 'lisp_hot_contract') return await this.contract(owner, scope, id, hash, raw, combined)
      if (tool === 'lisp_hot_install') return await this.install(owner, scope, id, hash, raw, combined)
      if (tool === 'lisp_hot_call') return await this.call(owner, scope, id, hash, raw, combined)
      return await this.deactivate(owner, scope, id, hash, raw, combined)
    } catch (error) {
      const old = await this.options.store.get(owner, id)
      // A COMMIT can succeed even when its acknowledgement is lost.
      if (old?.state === 'SUCCEEDED' && old.result) return JSON.parse(old.result) as unknown
      const problem = failure(error)
      if (old && ['RUNNING', 'AWAITING_APPROVAL'].includes(old.state)) {
        const state = problem.code === 'STOP_UNCONFIRMED' ? 'UNKNOWN' : combined.aborted ? 'CANCELLED' : 'FAILED'
        await this.options.store.transition(owner, id, [old.state], state, problem)
      }
      return problem
    } finally { this.#active.delete(controller) }
  }

  private async approve(owner: LispOwner, id: string, title: string, detail: string, signal: AbortSignal): Promise<void> {
    await this.options.store.transition(owner, id, ['RUNNING'], 'AWAITING_APPROVAL', { phase: 'awaiting_approval' })
    const approval = await confirm(this.options.questions, owner, {
      id: `lisp-hot-${id}`, header: 'Lisp · プロジェクト共有', question: title, detail,
      options: [{ label: '取り消す' }, { label: '承認する' }], intent: { kind: 'plan-review', approve: '承認する' },
    }, signal)
    if (signal.aborted) fail('CANCELLED', '共有関数の確認を取り消しました。')
    if (!approval.approved) fail('HOT_APPROVAL_REQUIRED', `承認されませんでした: ${approval.message ?? approval.reason}`)
    const pending = await this.options.store.get(owner, id)
    await this.options.store.transition(owner, id, ['AWAITING_APPROVAL'], 'AWAITING_APPROVAL', { phase: 'approved', approval: approval.source ?? 'manual' }, { ...JSON.parse(pending!.payload), approval: approval.source ?? 'manual' })
  }

  private async contract(owner: LispOwner, scope: Scope, id: string, hash: string, raw: unknown, signal: AbortSignal): Promise<unknown> {
    const request = parseHotContract(raw)
    const current = (await this.catalog.status(scope.projectRoot, request.name))[0]
    if ((current?.contractRef ?? null) !== request.expectedContractRef) fail('HOT_CONTRACT_CONFLICT', '承認対象の条件が変わっています。最新の条件を確認してください。')
    await this.options.store.reserve(owner, id, 'lisp_hot_contract', hash, scope.epoch, { projectRoot: scope.projectRoot, request })
    // JSON is displayed in a fence longer than any caller-supplied backtick run.
    const data = JSON.stringify({ projectRoot: scope.projectRoot, ...request }, null, 2)
    const fence = '`'.repeat(Math.max(2, ...Array.from(data.matchAll(/`+/g), match => match[0].length)) + 1)
    await this.approve(owner, id, 'このプロジェクトで共有する検証条件を登録しますか？',
      '以下は未信頼の提案データです。型と全入力・期待値を確認してください。承認後は、条件を満たす候補への更新を自動で許可します。'
      + '条件の変更には再承認が必要です。既存の稼働版は、新しい候補が検証に成功するまで維持します。\n\n'
      + `${fence}json\n${data}\n${fence}`, signal)
    await this.scope(owner, signal, scope)
    return this.catalog.approve(owner, scope.epoch, scope.projectRoot, id, request)
  }

  private async install(owner: LispOwner, scope: Scope, id: string, hash: string, raw: unknown, signal: AbortSignal): Promise<unknown> {
    const request = HotInstallInput.parse(raw)
    const head = (await this.catalog.status(scope.projectRoot, request.name))[0]
    if (head?.contractRef !== request.contractRef) fail('HOT_CONTRACT_CONFLICT', '現在承認されている条件を指定してください。')
    if ((head?.revision ?? 0) !== request.expectedRevision) fail('HOT_REVISION_CONFLICT', '稼働版が変わっています。')
    const contract = await this.catalog.contract(scope.projectRoot, request.contractRef, request.name)
    const source = await new TaskToolCatalog(this.options.store).executable(owner, request)
    if (Buffer.byteLength(source) > 262144) fail('HOT_SOURCE_LIMIT', '依存関数を含むコードが256 KiBを超えています。')
    const bundle = { name: request.name, contractRef: request.contractRef, source, inputSchema: contract.inputSchema, outputSchema: contract.outputSchema }
    await this.options.store.reserve(owner, id, 'lisp_hot_install', hash, scope.epoch, {
      projectRoot: scope.projectRoot, name: request.name, contractRef: request.contractRef,
      expectedRevision: request.expectedRevision, sourceDigest: digest(source), phase: 'checking', checked: 0, total: contract.properties.length,
    })
    await this.options.run(owner, source, null, signal, 'compile')
    for (const [index, property] of contract.properties.entries()) {
      await this.scope(owner, signal, scope)
      const result = await this.options.run(owner, source, property.input, signal)
      validateValue(contract.outputSchema, result.value)
      if (digest(result.value) !== digest(property.expected)) fail('HOT_PROPERTY_FAILED', `検証条件 ${index + 1} の出力が期待値と一致しません。稼働版は変更していません。`)
      await this.options.store.transition(owner, id, ['RUNNING'], 'RUNNING', { phase: 'checking', checked: index + 1, total: contract.properties.length })
    }
    await this.scope(owner, signal, scope)
    return this.catalog.activate(owner, scope.epoch, scope.projectRoot, id, {
      name: request.name, contractRef: request.contractRef, expectedRevision: request.expectedRevision, bundle,
    })
  }

  private async call(owner: LispOwner, scope: Scope, id: string, hash: string, raw: unknown, signal: AbortSignal): Promise<unknown> {
    const request = HotCallInput.parse(raw)
    const selected = await this.catalog.active(scope.projectRoot, request.name)
    const value = request.inputRef ? await this.options.input(owner, request.inputRef) : request.input
    validateValue(selected.bundle.inputSchema, value)
    await this.scope(owner, signal, scope)
    await this.options.store.reserve(owner, id, 'lisp_hot_call', hash, scope.epoch, {
      projectRoot: scope.projectRoot, name: request.name, bundleRef: selected.bundleRef,
      revision: selected.revision, contractRef: selected.contractRef, inputDigest: digest(value),
    })
    const result = await this.options.run(owner, selected.bundle.source, value, signal)
    validateValue(selected.bundle.outputSchema, result.value)
    await this.scope(owner, signal, scope)
    const ref = randomUUID()
    const source = request.inputRef ? await this.options.store.get(owner, request.inputRef) : undefined
    const lineage = source ? JSON.parse(source.payload) as { sourceRefs?: string[] } : undefined
    const response = { ok: true, operationId: id, name: request.name, resultRef: ref, bundleRef: selected.bundleRef,
      revision: selected.revision, value: request.fields?.length ? selectFields(result.value, request.fields, ref) : result.value,
      output: result.output, generation: result.generation }
    signal.throwIfAborted()
    await this.catalog.completeCall(owner, scope.epoch, scope.projectRoot, id, ref, {
      operationId: id, bundleRef: selected.bundleRef,
      sourceRefs: request.inputRef ? [...new Set([request.inputRef, ...(lineage?.sourceRefs ?? [])])] : [],
    }, result.value, response)
    return response
  }

  private async deactivate(owner: LispOwner, scope: Scope, id: string, hash: string, raw: unknown, signal: AbortSignal): Promise<unknown> {
    const request = HotDeactivateInput.parse(raw)
    const selected = await this.catalog.active(scope.projectRoot, request.name)
    if (selected.revision !== request.expectedRevision) fail('HOT_REVISION_CONFLICT', '稼働版が変わっています。')
    await this.options.store.reserve(owner, id, 'lisp_hot_deactivate', hash, scope.epoch, { projectRoot: scope.projectRoot, ...request })
    await this.approve(owner, id, `共有関数 ${request.name} を無効にしますか？`,
      `対象プロジェクト: ${scope.projectRoot}\n版: ${selected.revision}\n新しい呼び出しを停止します。実行中の呼び出しと保存済み結果は維持します。`, signal)
    await this.scope(owner, signal, scope)
    return this.catalog.deactivate(owner, scope.epoch, scope.projectRoot, id, request)
  }
}
