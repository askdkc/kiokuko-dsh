/** Incident-shaped, anonymized requests through the real provider decoder,
 * finite judge and native preparation tool. Inference is scripted: this does
 * not reproduce or certify the live model's semantic judgment. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DecisionService } from '../../../src/dsh/decisions/service.js'
import { TypedDecisionsConfig } from '../../../src/dsh/decisions/config.js'
import { TypeSafeDecisionProvider } from '../../../src/dsh/decisions/providers.js'
import { assessRequestIntent as sourceAssessRequestIntent } from '../../../src/dsh/decisions/intent-assessment.js'
import { createRequestIntentContext, requestIntentMessageRefs, requestIntentReferenceIds, unresolvedRequestIntent } from '../../../src/dsh/decisions/request-intent.js'
import { OnDemandIntake as SourceOnDemandIntake, TASK_PREPARE_TOOL } from '../../../src/dsh/on-demand-intake.js'
import { mountNativeTools, executeNativeTool } from '../helpers/native-tools.js'

const artifact = process.env.KIOKUKO_OWNED_PACKAGE_ROOT
const assessRequestIntent: typeof sourceAssessRequestIntent = artifact
  ? (await import(pathToFileURL(join(artifact, 'dist/dsh/decisions/intent-assessment.js')).href)).assessRequestIntent : sourceAssessRequestIntent
const OnDemandIntake: typeof SourceOnDemandIntake = artifact
  ? (await import(pathToFileURL(join(artifact, 'dist/dsh/on-demand-intake.js')).href)).OnDemandIntake : SourceOnDemandIntake
const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const load = (name: string) => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)
const [cordis, nativeTools] = await Promise.all([load('cordis'), load('dsh-tools')])
const criteria = ['action', 'reference', 'constraints', 'latest-answer']
const signal = () => new AbortController().signal
const requests = [
  { relation: 'same_scope_continuation', task: 'Prevent this reconciliation failure from happening again.' },
  { relation: 'new', task: 'RECONCILIATION_REQUIRED\nCreate a Rust program that keeps SBCL in the background and handles Lisp requests.' },
] as const

for (const request of requests) for (const verdict of ['supported', 'insufficient', 'uncertain', 'tie', 'partial-uncertain', 'partial-insufficient', 'contradicted'] as const) {
  test(`captured ${request.relation}: ${verdict} preserves evidence and admission`, { timeout: 10000 }, async t => {
    const message = { id: 'current-human', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: request.task }] }
    const context = createRequestIntentContext({ task: request.task, messageRefs: requestIntentMessageRefs([message], request.task),
      activeTask: { taskId: 'task-current', runId: 'task-current', sessionId: 'captured-session', sourceSessionId: 'captured-session',
        repositoryRoot: '/tmp/captured-repository', type: 'debug', state: 'Working', revision: 3, generation: 2, runStatus: 'active',
        reason: 'explicit implementation request', evidence: [], allowedOps: ['wait', 'complete', 'ignore'], resumedFromTerminal: false,
        request: 'Fix Lisp execution and recovery. Preserve repository ownership and native permissions. Do not publish.' } })!
    assert.ok(context)
    assert.equal(requestIntentReferenceIds(context).length, 2, 'message and active task are the two incident-shaped refs')
    const config = TypedDecisionsConfig.parse({ provider: 'typesafe' })
    let providerCalls = 0, assessments = 0, admissions = 0, effects = 0, questions = 0, ready = false
    const decisions = new DecisionService(config, (_config, observer) => new TypeSafeDecisionProvider(config.typesafe, async () => 'fixture-key', async (_url, init) => {
      providerCalls++
      const wire = JSON.parse(String(init!.body))
      assert.deepEqual(wire.state.source, context, 'exact original task, task request and refs reach the comparison wire')
      assert.deepEqual(Object.keys(wire.questions), criteria.map(name => `semantic-${name}`))
      assert.equal(wire.state.candidate.relation, request.relation)
      assert.equal(wire.state.candidate.action, 'change'); assert.equal(wire.state.candidate.changeScope, 'implementation')
      assert.equal(wire.state.candidate.evidence.taskRevision, 3); assert.equal(wire.state.candidate.evidence.taskGeneration, 2)
      assert.equal(wire.state.candidate.taskOperation, null, 'ordinary implementation is not a task lifecycle operation')
      return Response.json({ answers: Object.fromEntries(criteria.map((name, index) => {
        const partial = verdict.startsWith('partial-')
        const decision = partial ? index === 1 ? verdict.slice('partial-'.length) : 'supported' : verdict
        const choice = decision === 'uncertain' || decision === 'tie' ? 'supported' : decision
        const probabilities = decision === 'tie' ? { supported: .5, contradicted: .5, insufficient: 0 }
          : { supported: choice === 'supported' ? 1 : 0, contradicted: choice === 'contradicted' ? 1 : 0, insufficient: choice === 'insufficient' ? 1 : 0 }
        return [`semantic-${name}`, { type: 'choice', choice, probabilities, confidence: decision === 'uncertain' ? 0 : 1 }]
      })) })
    }, observer))
    const ctx = new cordis.Context(), fibers: any[] = []
    ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {}, getSectionOrder: () => 0 })
    await mountNativeTools(ctx, nativeTools, packages, fibers)
    const session = { id: 'captured-session', snapshotEvents: () => [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }] }
    const agent = { id: 'captured-agent', session }
    const intake = new OnDemandIntake({ validate: async () => {}, existing: async () => false,
      classify: async () => ({ deferInference: true }), requestContext: async () => context,
      interpret: async () => ({ context, decision: unresolvedRequestIntent(context, 'fixture_classifier_abstained') }),
      assess: async (_input, source, candidate) => { assessments++; return assessRequestIntent(decisions, 'captured-request', source, candidate, signal()) },
      prepare: async () => { admissions++; ready = true; return true }, ready: () => ready,
      questions: { async ask(request) { questions++; return { answers: [{ id: request.questions[0].id, selected: [] }] } } },
    })
    intake.mount(ctx, ctx.tools)
    const release = ctx.tools.register({ name: 'effect_probe', parameters: { type: 'object' },
      output: { schema: {}, render: () => [] }, execute: () => ++effects })
    t.after(async () => { await intake.dispose(); release(); for (const f of fibers.reverse()) await f.dispose() })
    await intake.capture({ agent, turn: 1, step: 0, messages: [message], signal: signal() })
    let call = 0
    const execute = (name: string, args: unknown) => executeNativeTool(ctx, packages, { callId: `captured-${++call}`, name, arguments: args, agent, signal: signal() })
    const submit = { requestIntent: { relation: request.relation, action: 'change', changeScope: 'implementation', evidenceRefs: requestIntentReferenceIds(context) } }
    const foreign = await execute(TASK_PREPARE_TOOL, { requestIntent: { ...submit.requestIntent, evidenceRefs: ['foreign-ref'] } })
    assert.equal((foreign.value as any)?.prepared === true, false); assert.equal(admissions, 0); assert.equal(providerCalls, 0)
    const result = await execute(TASK_PREPARE_TOOL, submit)
    assert.equal(result.isError, false)
    const value = result.value as any
    assert.equal(value.prepared, verdict === 'supported')
    assert.equal(providerCalls, 1); assert.equal(assessments, 1); assert.equal(admissions, verdict === 'supported' ? 1 : 0)
    if (verdict === 'supported') {
      assert.equal((await execute('effect_probe', {})).isError, false); assert.equal(effects, 1)
    } else if (verdict !== 'contradicted') {
      assert.equal(value.status, 'assessment_rejected')
      assert.deepEqual(value.semanticChecks, criteria.map((criterion, index) => verdict.startsWith('partial-') && index !== 1
        ? { criterion, status: 'selected', choiceId: 'supported' }
        : { criterion, status: 'abstained', reason: verdict.replace('partial-', '') }))
      assert.equal(questions, 0, 'Provider abstention alone must not ask the human to repair inference')
      assert.equal(value.nextAction, verdict.endsWith('insufficient') ? 'revise_request_intent_or_report_conflict' : 'report_assessment_uncertainty')
      assert.equal(value.originalTask, request.task)
      assert.equal((await execute('effect_probe', {})).isError, true); assert.equal(effects, 0)
      assert.equal((await execute(TASK_PREPARE_TOOL, submit)).value.prepared, false)
      assert.equal(providerCalls, 1, 'identical submission does not reissue inference')
      assert.equal(admissions, 0)
    }
    assert.equal(effects, verdict === 'supported' ? 1 : 0)
    assert.equal(admissions, verdict === 'supported' ? 1 : 0)
  })
}
