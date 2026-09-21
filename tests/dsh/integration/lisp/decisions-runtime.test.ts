import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, realpath, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'
import { LispManager } from '../../../../src/dsh/lisp/manager.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { DecisionService } from '../../../../src/dsh/decisions/service.js'
import { TypedDecisionsConfig } from '../../../../src/dsh/decisions/config.js'
import { LayaCoreMLDecisionProvider } from '../../../../src/dsh/decisions/laya-coreml.js'
import { layaConfig, layaReply } from '../../helpers/laya.js'
import { NimbleDecisionProvider, TypeSafeDecisionProvider } from '../../../../src/dsh/decisions/providers.js'

for (const provider of ['typesafe', 'nimble', 'laya-coreml'] as const) test(`protected Lisp ${provider}: neutral helpers consume decisions without effects and discard late cancellation`, {
  skip: process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires protected SBCL' : false, timeout: 180000,
}, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'neutral-lisp-'))), root = join(base, 'work'); await mkdir(root)
  const db = new NodeSqliteAdapter(join(base, 'db'), new DatabaseSync(join(base, 'db')))
  db.exec(await readFile(new URL('../../../../migrations/019_dsh_lisp.sql', import.meta.url), 'utf8'))
  const owner = { sessionId: 'session', agentId: 'agent', root }, config = provider === 'laya-coreml' ? layaConfig() : TypedDecisionsConfig.parse({ provider, nimble: { endpoint: 'http://localhost:8000/v1/systemone', model: 'fixture-model' } })
  let mode = 'selected', calls = 0, began!: () => void, late!: (response: Response) => void, requestSignal: AbortSignal | undefined
  const request: typeof fetch = async (_url, options) => {
    calls++; requestSignal = options!.signal!
    if (mode === 'hang') { began(); return new Promise(resolve => { late = resolve }) }
    if (mode === 'error') return new Response('', { status: 503 })
    const input = JSON.parse(String(options!.body))
    return Response.json({ model: input.model, answers: Object.fromEntries(Object.entries(input.questions).map(([id, q]: [string, any]) => {
      const keys = Object.keys(q.criteria), choice = mode === 'abstained' ? 'abstain' : keys[0]
      return [id, { type: 'choice', choice, probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? 1 : 0])), confidence: 1 }]
    })) })
  }
  const service = new DecisionService(config, () => provider === 'laya-coreml' ? new LayaCoreMLDecisionProvider(config['laya-coreml'], async (_path, json, signal) => {
    const input = JSON.parse(json)
    if (input.op === 'health') return layaReply(input)
    calls++; requestSignal = signal
    if (mode === 'hang') { began(); return new Promise(resolve => { late = resolve }) }
    if (mode === 'error') return { version: 1, ok: false, error: { code: 'unavailable' } }
    return layaReply(input, (_id, keys) => mode === 'abstained' ? 'abstain' : keys[0]!)
  }) : provider === 'typesafe' ? new TypeSafeDecisionProvider(config.typesafe, async () => 'private-host-key', request) : new NimbleDecisionProvider(config.nimble, async () => undefined, request))
  const manager = new LispManager({ store: new LispStore(async fn => fn(db)), config: LispConfig.parse({ enabled: true, sbclPath: process.env.KIOKUKO_LISP_SBCL ?? 'sbcl', startupTimeoutMs: 60000 }), dataRoot: join(base, 'data'),
    decisionCall: async (bound, method, args, context) => { assert.deepEqual(bound, owner); assert.ok(context.generation && context.evaluationId); return method === 'decisions-status' ? service.status() : service.evaluate(context.evaluationId, args, context.signal) },
  })
  const evaluate = (id: string, code: string, signal?: AbortSignal) => manager.execute(owner, 'lisp_eval', { operationId: id, code }, signal) as Promise<any>
  const candidates = '(vector (kioku.data:parse-json "{\\\"id\\\":\\\"module\\\",\\\"description\\\":\\\"Import failure\\\"}"))'
  try {
    await manager.start(); assert.equal((await manager.enable(owner) as any).state, 'READY')
    assert.equal((await evaluate('status', '(kioku.decisions:status)')).value.json.provider, provider); assert.equal(calls, 0)
    const relevance = `(kioku.decisions:assess-relevance "requirement" ${candidates})`
    const selected = await evaluate('relevance', relevance)
    assert.equal(selected.ok, true, JSON.stringify(selected)); assert.equal(selected.value.json.result.answers[0].choiceId, 'yes')
    assert.deepEqual(selected.changes, [])
    assert.equal((await evaluate('failure', `(kioku.decisions:classify-failure "error" ${candidates})`)).value.json.result.answers[0].choiceId, 'module')
    assert.equal((await evaluate('change', '(kioku.decisions:assess-change "requirement" "before" "after")')).value.json.result.answers[0].choiceId, 'yes')
    mode = 'abstained'; assert.equal((await evaluate('abstain', relevance)).value.json.result.answers[0].status, 'abstained')
    mode = 'error'; assert.equal((await evaluate('fallback', relevance)).value.json.status, 'fallback')
    mode = 'hang'; const started = new Promise<void>(resolve => { began = resolve }), controller = new AbortController()
    const pending = evaluate('cancelled', relevance, controller.signal); await started; controller.abort()
    assert.equal((await pending).ok, false); assert.equal(requestSignal!.aborted, true)
    late(Response.json({})); await manager.recover(owner)
    assert.equal((await evaluate('ordinary', '(+ 1 2)')).value.json, 3)
  } finally { await manager.dispose(); db.close(); await rm(base, { recursive: true, force: true }) }
})
