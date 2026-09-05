import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { initializeDatabase } from '../../../src/dsh/database.js'
import { openConnection } from '../../../src/db/connection.js'
import { createDshCapabilityCatalog } from '../../../src/dsh/capability-catalog.js'
import { createDshHostAdapter } from '../../../src/dsh/host-adapter.js'
import { mountDshComposition } from '../../../src/dsh/composition.js'
import { submitEnnoAdvice } from '../../../src/enno-oduno/service.js'
import { registerRepositoryAndLocation } from '../../../src/repository/binding.js'
import { compareCanonicalStrings } from '../../../src/serialization/validate.js'
import { STANDARD_SKILL_MANIFESTS } from '../../../src/dsh/standard-skills.js'
import { dshTurnBoundarySeq } from '../../../src/dsh/session-memory-finalizer.js'
import { nativeMock } from '../helpers/native-mock.js'

const dshSourceRoot = process.env.KIOKUKO_DSH_SOURCE_ROOT
const dshPackageRoot = process.env.KIOKUKO_DSH_PACKAGE_ROOT
if (process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1' && !dshSourceRoot && !dshPackageRoot) throw new Error('Mandatory DSH native coverage requires the pinned runtime')

function dshModule(relativePath: string): string {
  if (dshSourceRoot !== undefined) return pathToFileURL(join(dshSourceRoot, relativePath)).href
  if (dshPackageRoot === undefined) throw new Error('A DSH runtime is required')
  const name = relativePath.startsWith('vendor/') ? 'cordis' : `dsh-${relativePath.split('/').at(-3)}`
  return pathToFileURL(join(dshPackageRoot, '@deepseek-ai', name, 'lib/index.js')).href
}

for (const finalMode of ['text', 'empty', 'error', 'stall', 'pause', 'verifier_mutation'] as const) {
test(`real DSH agent loop: persisted resume, verification retry, completion (${finalMode})`, {
  skip: !dshSourceRoot && !dshPackageRoot ? 'requires the pinned DeepSeek Harness runtime' : false,
  timeout: 60_000,
}, async () => {
  const [cordis, llm, session, projection, systemPrompt, tools, agentRegistry, agentLoop, skills] = await Promise.all([
    import(dshModule('vendor/cordis/lib/index.js')),
    import(dshModule('packages/llm/llm/lib/index.js')),
    import(dshModule('packages/core/session/lib/index.js')),
    import(dshModule('packages/session/session-projection/lib/index.js')),
    import(dshModule('packages/core/system-prompt/lib/index.js')),
    import(dshModule('packages/core/tools/lib/index.js')),
    import(dshModule('packages/core/agent/lib/index.js')),
    import(dshModule('packages/core/agent-loop/lib/index.js')),
    import(dshModule('packages/skill/skill/lib/index.js')),
  ])
  const mock = nativeMock(llm)
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-real-loop-'))
  const dataRoot = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-real-loop-data-'))
  await mkdir(join(fixtureRoot, 'src'))
  execFileSync('git', ['init', '-q', fixtureRoot])
  const databasePath = join(dataRoot, 'data.sqlite3')
  await initializeDatabase({ databasePath })
  const database = openConnection(databasePath)
  try {
    registerRepositoryAndLocation(database, {
      repositoryId: 'repo-real-loop',
      workspace: 'workspace-real-loop',
      displayName: 'real loop',
      canonicalRoot: realpathSync(fixtureRoot),
      remoteFingerprint: null,
      bindingSchemaVersion: 1,
      agentTemplateVersion: 1,
    })
  } finally {
    database.close()
  }

  const ideal = {
    objective: 'Implement PLAN.md completely.',
    principles: ['Preserve existing behavior.'],
    skillContributions: [],
    successSignals: ['The requested implementation is verified.'],
  }
  const focusedRetryMarker = join(fixtureRoot, 'focused-verifier-retry-ready')
  const plan = {
    executionHints: [{ field: 'constraints', text: 'Keep the native workflow recoverable.', quote: '@PLAN.md を実装' }],
    scope: ['src'],
    exclusions: [],
    acceptanceCriteria: [{ id: 'verified', description: 'The final verifier passes.\nNo approved checks are omitted.' }],
    workPlan: {
      objective: 'Implement and verify the requested plan.',
      units: [{
        id: 'implement-plan',
        objective: 'Implement PLAN.md.',
        scope: ['src'],
        dependencies: [],
        routes: ['code'],
        skillNames: ['kiokuko-single-purpose-functions'],
        expertRefs: [{ id: 'code.verification.v1', reason: 'Verify the requested behavior.' }],
        acceptanceCriteria: ['The final verifier passes.'],
        focusedVerifiers: [{
          id: 'focused-fail-once', kind: 'test', executable: process.execPath,
          args: [
            '--eval',
            `const fs = require("node:fs"); const marker = ${JSON.stringify(focusedRetryMarker)}; if (fs.existsSync(marker)) process.exit(0); fs.writeFileSync(marker, "ready"); process.exit(1);`,
          ],
          cwd: '.', timeoutMs: 5_000,
        }],
      }],
    },
    skillRequirements: [],
    finalVerifiers: [{
      id: 'final-test', kind: 'test', executable: process.execPath,
      args: ['--eval', finalMode === 'verifier_mutation'
        ? 'require("node:fs").writeFileSync("compiled.elc", "artifact")' : 'process.exit(0)'], cwd: '.', timeoutMs: 5_000,
    }],
    maxAttempts: finalMode === 'verifier_mutation' ? 8 : 3,
    provenance: {
      scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
      workPlan: 'inferred', skillSet: 'repository_evidence', finalVerifiers: 'repository_evidence',
      maxAttempts: 'inferred',
    },
  }
  const dispositions = (slotIds: string[]) => slotIds.map((slotId) => ({
    slotId,
    disposition: 'adopted',
    rationale: `Applied the ${slotId} evidence.`,
  }))
  const idealDispositions = dispositions(['constraint_guardian', 'skill_trust_analyst', 'success_signal_critic'])
  const planningDispositions = dispositions(['workunit_architect', 'protocol_risk_reviewer', 'verification_designer'])
  const finalReviewDispositions = dispositions(['acceptance_auditor', 'regression_adversary', 'evidence_freshness_reviewer'])
  const workResult = {
    result: { outcome: 'completed', summary: 'Implementation completed.', mutated: false, changedPaths: [] },
  }
  const flowResponses = (suffix: string, longPlanningStep = false, failBeforeWork = false, retryWork = false) => [
    mock.textResponse('The ideal is ready for the host advisory round.'),
    mock.toolCallResponse(`ideal-${suffix}`, 'enno_ideal_submit', { ideal, advisoryDisposition: idealDispositions }),
    mock.textResponse(longPlanningStep
      ? `The plan is ready for the host advisory round. ${'x'.repeat(4_531)}`
      : 'The plan is ready for the host advisory round.'),
    mock.toolCallResponse(`plan-${suffix}`, 'enno_plan_submit', { ...plan, advisoryDisposition: planningDispositions }),
    ...(finalMode === 'pause' && suffix === 'one' ? [1, 2, 3, 4].map(index => mock.toolCallResponse(`repeated-${index}`, 'read', { file_path: 'src/fixture.ts' })) : []),
    ...(failBeforeWork ? [() => { throw new llm.LlmError('WebSocket error', 'PI_AI_ERROR') }] : []),
    mock.toolCallResponse(`work-${suffix}`, 'enno_work_report', workResult),
    ...(retryWork ? [mock.toolCallResponse(`work-${suffix}-retry`, 'enno_work_report', workResult)] : []),
    ...(finalMode === 'verifier_mutation' ? [
      mock.toolCallResponse(`plan-${suffix}-repair`, 'enno_plan_submit', {
        ...plan, advisoryDisposition: planningDispositions,
        finalVerifiers: [{ ...plan.finalVerifiers[0], args: ['--eval', 'process.exit(0)'] }],
      }),
      mock.toolCallResponse(`work-${suffix}-repair`, 'enno_work_report', workResult),
    ] : []),
    mock.toolCallResponse(`finish-${suffix}`, 'enno_finish', {
      advisoryDisposition: finalReviewDispositions,
      review: { decision: 'accept', summary: 'All approved work and final verification passed.' },
    }),
    mock.toolCallResponse(`meditation-${suffix}`, 'enno_meditation_submit', {
      meditation: { summary: 'No obsolete tests or functions were found.', inspectedPaths: ['src'], deletionCandidates: [] },
    }),
    finalMode === 'error' ? () => { throw new llm.LlmError('Final response unavailable', 'PI_AI_ERROR') }
      : mock.textResponse(finalMode === 'empty' ? '' : `Completed ${suffix}: implementation and verification succeeded; no deletion candidates remain.`),
  ]
  const secondFlow = flowResponses('two')
  const adapterScript = new mock.MockAdapter(finalMode === 'stall'
    ? Array.from({ length: 8 }, () => mock.textResponse('I have not submitted the required phase.')) : [
    ...flowResponses('one', true, false, true),
    ...secondFlow.slice(0, 4),
    mock.toolCallResponse('plan-two-revised', 'enno_plan_submit', { ...plan, advisoryDisposition: planningDispositions }),
    ...secondFlow.slice(4),
    mock.textResponse('Yes. The requested implementation and verification are complete.'),
    mock.textResponse('fix(dsh): keep long Enno sessions recoverable'),
  ])
  const ctx = new cordis.Context()
  await ctx.plugin(llm.default)
  await ctx.plugin(session.default)
  await ctx.plugin(projection.default)
  await ctx.plugin(systemPrompt.default, { persona: '' })
  await ctx.plugin(tools.default)
  await ctx.plugin(agentRegistry.default)
  await ctx.plugin(skills.default)
  await ctx.plugin(agentLoop.default, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapterScript)
  let exploratoryReads = 0
  const readDisposer = finalMode === 'pause' ? ctx.tools.register({ name: 'read', description: 'Read fixed source evidence.',
    parameters: { file_path: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args: unknown, text: string) => [{ type: 'text', text }] },
    execute: () => { exploratoryReads++; return 'unchanged source evidence' },
  }) : undefined
  let confirmations = 0
  let recoveryQuestions = 0
  const confirmationPresentationKinds: string[] = []
  const confirmationSawCompletedPlanResult: boolean[] = []
  const confirmationQuestions: string[] = []
  const confirmationDetails: string[] = []
  let liveAgent: any
  const boundaryFailures: string[] = []
  const questionFiber = ctx.plugin({
    name: 'kiokuko-dsh-real-loop-questions',
    apply(questionContext: any) {
      return questionContext.provide('userQuestions', {
        async ask(request: any) {
          assert.equal(request.agent, liveAgent, 'every user question must use the exact live DSH Agent scope')
          const question = request.questions[0]
          if (question.id.startsWith('boundary-')) {
            boundaryFailures.push(question.detail)
            return { answers: [{ id: question.id, selected: [], custom: '' }] }
          }
          if (question.id.startsWith('loop-') || question.id.startsWith('effect-')) {
            recoveryQuestions++
            return { answers: [{ id: question.id, selected: [], custom: '' }] }
          }
          if (question.id === 'kiokuko-plan-confirmation') {
            confirmations += 1
            confirmationPresentationKinds.push(question.intent?.kind ?? 'generic')
            confirmationQuestions.push(question.question)
            confirmationDetails.push(question.detail)
            const expectedPlanCall = (finalMode === 'verifier_mutation'
              ? ['plan-one', 'plan-one-repair'] : ['plan-one', 'plan-two', 'plan-two-revised'])[confirmations - 1]
            confirmationSawCompletedPlanResult.push(liveAgent.session.snapshotEvents().some((event: any) => (
              event.type === 'tool/result'
              && event.data.message.content[0]?.toolCallId === expectedPlanCall
            )))
            assert.deepEqual(question.options.map((option: any) => option.label), ['approve', 'cancel'])
            if (confirmations === 2 && finalMode !== 'verifier_mutation') {
              throw Object.assign(new Error('the user chose Chat about it'), { code: 'ASK_CANCELLED' })
            }
          }
          return { answers: [{ id: question.id, selected: [question.id === 'kiokuko-plan-confirmation' ? 'approve' : 'build'] }] }
        },
      })
    },
  })
  await questionFiber

  const adapter = createDshHostAdapter(ctx, {
    repositoryRoot: fixtureRoot,
    databasePath,
    migrationsDirectory: join(process.cwd(), 'migrations'),
    sessionQuery: {
      async readSession(sessionId) {
        assert.equal(sessionId, liveAgent.session.id)
        return {
          session: liveAgent.session.header,
          inheritedEventCount: liveAgent.session.inheritedEventCount,
          events: liveAgent.session.snapshotEvents(),
        }
      },
    },
    llm: {
      async * stream() {
        yield { type: 'text-delta', index: 0, text: '{"schemaVersion":1,"memories":[]}' }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 8 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    advisory: {
      verifyReadOnly: () => true,
      execute: async (call) => ({
        slotId: call.slotId,
        outcome: 'completed',
        summary: `Checked ${call.slotId}.`,
        recommendations: [],
        risks: [],
        evidence: [],
      }),
    },
  })
  const composition = await mountDshComposition(ctx, adapter.host)
  try {
    liveAgent = await ctx.agentLoop.create(
      session.SessionId('real-loop-session'),
      { provider: 'mock', model: 'mock' },
      { cwd: fixtureRoot },
    )
    const signal = new AbortController().signal
    const nativeSkillSnapshot = await ctx.skills.snapshot({ scope: liveAgent, cwd: fixtureRoot, signal })
    const nativeToolSnapshot = await ctx.tools.schemas(liveAgent)
    const mandatoryOrder = new Map(STANDARD_SKILL_MANIFESTS.map((manifest, index) => [manifest.name, index]))
    const recoveryCatalog = createDshCapabilityCatalog({
      skills: nativeSkillSnapshot.skills
        .map((skill: any) => ({ kind: 'skill', name: skill.name, ...(skill.description === undefined ? {} : { description: skill.description }) }))
        .sort((left: any, right: any) => {
          const leftOrder = mandatoryOrder.get(left.name)
          const rightOrder = mandatoryOrder.get(right.name)
          if (leftOrder !== undefined || rightOrder !== undefined) return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER)
          return compareCanonicalStrings(left.name, right.name)
        }),
      tools: nativeToolSnapshot
        .map((tool: any) => ({ kind: 'tool', name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }) }))
        .sort((left: any, right: any) => compareCanonicalStrings(left.name, right.name)),
    })
    let seededRunId = ''
    await adapter.host.runtime!.withDatabase(async (seedDatabase) => {
      const seeded = await prepareAgentTask(seedDatabase, {
        requestId: 'pre-reload-active-run',
        task: '@PLAN.md を実装',
        cwd: fixtureRoot,
        profileHints: { taskType: 'build', target: fixtureRoot, expected: '@PLAN.md を実装\n変更を検証し、結果を報告してください。', constraints: '変更範囲を守る。\n無関係な変更はしない。' },
        capabilities: [...recoveryCatalog.skills, ...recoveryCatalog.tools],
        dshSessionId: liveAgent.session.id,
        skillDiscoveryMode: 'off',
        signal,
      })
      seededRunId = seeded.run.runId
      const advisory = seeded.ennoOduno.directive?.advisoryRound
      assert.ok(advisory)
      submitEnnoAdvice(seedDatabase, {
        runId: seeded.run.runId,
        workspace: seeded.project.workspace,
        orchestrationId: seeded.intake.sessionId,
        expectedRevision: 1,
        mutationRevision: 0,
        idempotencyKey: 'pre-reload-ideal-advice',
        phase: 'ideal',
        allowlistedContext: advisory.context,
        contributions: advisory.slots.map((slot) => ({
          slotId: slot.slotId,
          outcome: 'completed',
          summary: `Checked ${slot.slotId}.`,
          recommendations: [],
          risks: [],
          evidence: [],
        })),
      })
    })
    const completeTurn = async (task: string, ready: () => boolean | Promise<boolean>): Promise<void> => {
      liveAgent.followup(llm.createUserMessage({
        content: [{ type: 'text', text: task }], source: { kind: 'user' },
      }))
      for (let count = 0; count < 400; count++) {
        await new Promise(resolve => setTimeout(resolve, 25))
        if (liveAgent.status === 'idle' && await ready()) return
      }
      const state = await adapter.host.runtime!.withDatabase(db => Object.fromEntries([
        'enno_contracts', 'dsh_turn_receipts', 'dsh_boundary_jobs', 'dsh_exploration_states', 'dsh_execution_evidence',
      ].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all().map((row: any) => Object.fromEntries(Object.entries(row).filter(([key]) => !['contract_json', 'handoff_json', 'ideal_json', 'intake_discovery_json', 'meditation_json', 'payload_json'].includes(key))))])))
      throw new Error('Native workflow did not settle: ' + JSON.stringify({ state, events: liveAgent.session.snapshotEvents()
        .filter((e: any) => e.type === 'tool/result' || e.type === 'turn/end').slice(-8) }))
    }
    const completed = async (count: number) => adapter.host.runtime!.withDatabase(db =>
      db.prepare("SELECT COUNT(*) AS count FROM ledger_runs WHERE status = 'completed'").get<{ count: number }>()!.count >= count)
    if (finalMode === 'stall') {
      const waiting = async (questions: number) => recoveryQuestions === questions && adapter.host.runtime!.withDatabase(db =>
        !!db.prepare("SELECT job_id FROM dsh_boundary_jobs WHERE status = 'waiting_user'").get())
      await completeTurn('@PLAN.md を実装', () => waiting(1))
      assert.equal(adapterScript.requests.length, 4, 'initial request plus three automatic deliveries')
      adapter.host.boundaryWorker!.kick(liveAgent.session.id, liveAgent)
      await adapter.host.boundaryWorker!.whenIdle()
      assert.equal(recoveryQuestions, 1, 'empty answer must not automatically repeat the question')
      await completeTurn('現在の指示に従って処理を再開してください。', () => waiting(2))
      assert.equal(adapterScript.requests.length, 8, 'real human input opens exactly one new bounded generation')
      return
    }
    if (finalMode === 'pause') {
      await completeTurn('@PLAN.md を実装', () => adapter.host.runtime!.withDatabase(db =>
        !!db.prepare("SELECT run_id FROM dsh_exploration_states WHERE json_extract(state_json, '$.paused') = 1").get()))
      assert.equal(exploratoryReads, 4)
      const count = adapterScript.requests.length
      const receipts = await adapter.host.runtime!.withDatabase(db => db.prepare('SELECT count(*) AS n FROM dsh_turn_receipts').get<{ n: number }>()!.n)
      adapter.host.boundaryWorker!.kick(liveAgent.session.id, liveAgent)
      await adapter.host.boundaryWorker!.whenIdle()
      assert.equal(adapterScript.requests.length, count, 'intentional pause must not enqueue an unsubmitted-turn retry')
      assert.equal(await adapter.host.runtime!.withDatabase(db => db.prepare('SELECT count(*) AS n FROM dsh_turn_receipts').get<{ n: number }>()!.n), receipts)
      assert.equal(liveAgent.session.snapshotEvents().filter((e: any) => e.type === 'kiokuko/execution-status').length, 1)
      await completeTurn('記録済みの根拠を使って作業を再開してください。', () => completed(1))
      assert.equal(exploratoryReads, 4, 'resuming does not replay the read side effects')
      assert.match(JSON.stringify(liveAgent.session.snapshotEvents().filter((e: any) => e.type === 'assistant/message').at(-1)), /Completed one/)
      assert.deepEqual(boundaryFailures, [])
      return
    }
    await completeTurn('@PLAN.md を実装', () => completed(1))
    assert.deepEqual(boundaryFailures, [], 'multiline intake must not trigger an internal-error question')
    assert.match(confirmationDetails[0]!, /Keep the native workflow recoverable/)
    if (finalMode === 'verifier_mutation') {
      assert.equal(recoveryQuestions, 0, 'invalid verifier evidence must not loop until the no-progress modal')
      assert.equal(confirmations, 2, 'the repaired verifier requires approval')
      assert.deepEqual(confirmationSawCompletedPlanResult, [true, true])
      const finalEvidence = await adapter.host.runtime!.withDatabase(db => db.prepare(`
        SELECT contract_revision, changed_during_verification FROM enno_verifier_runs
        WHERE work_unit_id IS NULL ORDER BY contract_revision
      `).all())
      assert.deepEqual(finalEvidence.map(row => ({ ...row })), [
        { contract_revision: 2, changed_during_verification: 1 },
        { contract_revision: 4, changed_during_verification: 0 },
      ])
      assert.equal(liveAgent.session.snapshotEvents().filter((e: any) => e.type === 'tool/result')
        .some((e: any) => e.data.message.content[0]?.isError), false)
      return
    }
    if (finalMode !== 'text') {
      const reports = () => liveAgent.session.snapshotEvents().filter((e: any) => e.type === 'kiokuko/completion-report')
      assert.equal(reports().length, 1)
      assert.match(reports()[0].data.text, /final-test: passed/u)
      assert.match(reports()[0].data.text, /Implementation completed/u)
      assert.equal(reports()[0].data.source.kind, 'plugin')
      await adapter.host.resolveIdleClose!(liveAgent.id, liveAgent.session.id, liveAgent.session, liveAgent)
      assert.equal(reports().length, 1, 'repeated idle does not repeat the fallback report')
      const report = await adapter.host.runtime!.withDatabase(db => db.prepare('SELECT status FROM dsh_completion_reports').get())
      assert.equal(report?.status, 'delivered')
      return
    }
    await completeTurn('@PLAN.md の残りを実装\nREADME.org を短くし、use-package vc の導入手順を記載してください。', async () => confirmations === 2 && adapter.host.runtime!.withDatabase(db =>
      !!db.prepare("SELECT job_id FROM dsh_boundary_jobs WHERE status = 'waiting_user'").get()))
    await completeTurn('計画を src のみに絞って再提出してください。', () => completed(2))
    assert.deepEqual(boundaryFailures, [], 'a new multiline user request must reach planning and completion')
    const hasText = (text: string) => liveAgent.session.snapshotEvents().some((e: any) =>
      e.type === 'assistant/message' && e.data.message.content.some((b: any) => b.type === 'text' && b.text === text))
    await completeTurn('all fixed?', () => hasText('Yes. The requested implementation and verification are complete.'))
    await completeTurn('gimme commit message.', () => hasText('fix(dsh): keep long Enno sessions recoverable'))

    const toolEvents = liveAgent.session.snapshotEvents().filter((event: any) => event.type.startsWith('tool/'))
    const results = toolEvents.filter((event: any) => event.type === 'tool/result')
    const turnEnds = liveAgent.session.snapshotEvents().filter((event: any) => event.type === 'turn/end')
    const finalReports = liveAgent.session.snapshotEvents().filter((event: any) => (
      event.type === 'assistant/message'
      && event.data.message.content.some((block: any) => block.type === 'text' && /^Completed (?:one|two):/u.test(block.text))
    ))
    const longAssistantMessage = liveAgent.session.snapshotEvents().find((event: any) => (
      event.type === 'assistant/message' && event.sourceEventSeqs?.length > 2_048
    ))
    assert.ok(longAssistantMessage, 'the real loop must exercise a source sequence list larger than the former bridge limit')
    assert.deepEqual(results.map((event: any) => event.data.message.content[0]?.isError), Array(12).fill(false), JSON.stringify({ toolEvents, turnEnds }))
    const failedFocusedReport = results.find((event: any) => event.data.message.content[0]?.toolCallId === 'work-one')
    const failedFocusedPayload = JSON.parse(failedFocusedReport?.data.message.content[0]?.content[0]?.text ?? '{}').value
    assert.equal(failedFocusedPayload.verifierResults?.[0]?.status, 'failed')
    assert.equal(failedFocusedPayload.ennoOduno?.nextAction, 'execute_work_unit')
    assert.equal(failedFocusedPayload.executionLease?.workUnitId, 'implement-plan')
    assert.equal(results.some((event: any) => event.data.message.content[0]?.toolCallId === 'work-one-retry'), true)
    assert.equal(finalReports.length, 2, 'each completed Enno run must emit one visible final assistant report')
    assert.ok(turnEnds.length > 6, 'durable phases execute as separate native turns')
    assert.equal(confirmations, 3)
    assert.deepEqual(confirmationPresentationKinds, ['plan-review', 'plan-review', 'plan-review'])
    assert.deepEqual(confirmationSawCompletedPlanResult, [true, true, true])
    assert.deepEqual(confirmationQuestions, Array(3).fill('提案された計画を確認し、操作を選択してください。'))
    assert.equal(confirmationDetails.every((detail) => /^# 計画の確認$/mu.test(detail)), true)
    assert.equal(confirmationDetails.every((detail) => /^## 作業項目$/mu.test(detail)), true)
    const injectedTexts = liveAgent.session.snapshotEvents()
      .filter((event: any) => event.type === 'user/message' && event.data.source?.plugin === 'kiokuko-dsh')
      .flatMap((event: any) => event.data.content)
      .flatMap((block: any) => block.type === 'text' ? [block.text] : [])
    assert.equal(injectedTexts.some((text: string) => text.includes('# Kiokuko SOUL router')), false,
      'SOUL is already carried by the system prompt')
    const skillTexts = injectedTexts.filter((text: string) => text.startsWith('---\nname:') || text.startsWith('<!-- KIOKUKO MANAGED STANDARD SKILL:'))
    assert.equal(new Set(skillTexts).size, skillTexts.length,
      'phase changes and persisted resume must not append identical Skill bodies')
    assert.equal(injectedTexts.some((text: string) => text.includes('Current Kiokuko advisory evidence')), true)
    assert.equal(injectedTexts.some((text: string) => text.includes('ideal.skillContributions to exactly []')), true)
    assert.equal(injectedTexts.some((text: string) => text.includes('"maxItems":0')), true)
    assert.equal(
      injectedTexts.some((text: string) => text.includes('Return every item in userFacingConfirmation')),
      false,
      'DSH must settle confirmation at the host boundary instead of injecting a stale Enno confirmation role',
    )
    for (const disposition of [...idealDispositions, ...planningDispositions, ...finalReviewDispositions]) {
      assert.equal(injectedTexts.some((text: string) => text.includes(`Checked ${disposition.slotId}.`)), true)
    }
    const taskContexts = liveAgent.session.snapshotEvents()
      .filter((event: any) => event.type === 'user/message' && event.data.source?.plugin === 'kiokuko-dsh'
        && event.data.source.sections?.[0]?.name === 'user-task:user-task')
      .map((event: any) => event.data.content[0].text as string)
    assert.ok(taskContexts.some((text: string) => text.includes('変更を検証し、結果を報告してください。')),
      'additional intake requirements remain available')
    for (const task of ['@PLAN.md を実装', 'all fixed?', 'gimme commit message.']) {
      const humanEvents = liveAgent.session.snapshotEvents().filter((event: any) => event.type === 'user/message'
        && event.data.source?.kind === 'user' && event.data.content.some((block: any) => block.text === task))
      assert.equal(humanEvents.length, 1, 'the native loop retains each original request once')
      assert.equal(taskContexts.some((text: string) => text.includes(task)), false,
        'the plugin must not copy the native request into task context')
      assert.ok(adapterScript.requests.some((request: any) => request.messages.some((message: any) =>
        message.source?.kind === 'user' && message.content.some((block: any) => block.text === task))),
      'the original request reaches the model')
    }
    await adapter.host.memoryFinalizer!.whenIdle()
    const stored = openConnection(databasePath)
    try {
      const rows = stored.prepare('SELECT status, ideal_json, meditation_json FROM enno_contracts ORDER BY created_at').all<{
        status: string
        ideal_json: string | null
        meditation_json: string | null
      }>()
      assert.equal(rows.length, 2)
      assert.equal(rows.every((row) => row.ideal_json !== null), true, 'every ideal must be durably persisted')
      assert.equal(rows.every((row) => row.meditation_json !== null), true, 'every meditation must be durably persisted')
      assert.deepEqual(rows.map((row) => row.status), ['completed', 'completed'])
      const runRows = stored.prepare('SELECT run_id AS runId, route_epoch AS routeEpoch FROM enno_contracts ORDER BY created_at').all<{ runId: string; routeEpoch: number }>()
      assert.equal(runRows[0]?.runId, seededRunId)
      assert.notEqual(runRows[1]?.runId, seededRunId)
      assert.deepEqual(runRows.map((row) => row.routeEpoch), [0, 0])
      const jobs = stored.prepare(`
        SELECT run_id AS runId, status, cache_read_tokens AS cacheReadTokens,
               source_start_seq AS sourceStartSeq, source_end_seq AS sourceEndSeq,
               log_event_count AS logEventCount
          FROM dsh_memory_finalizations
         ORDER BY scheduled_at
      `).all<{
        runId: string
        status: string
        cacheReadTokens: number
        sourceStartSeq: number
        sourceEndSeq: number
        logEventCount: number
      }>()
      const completedRuns = stored.prepare(`
        SELECT run_id AS runId
          FROM ledger_runs
         WHERE status = 'completed'
      `).all<{ runId: string }>()
      assert.deepEqual(
        jobs.map(({ runId }) => runId).sort(),
        completedRuns.map(({ runId }) => runId).sort(),
        'every completed run, including lightweight follow-ups, must be finalized from the DSH log',
      )
      assert.equal(jobs.every(({ status, cacheReadTokens }) => status === 'completed' && cacheReadTokens === 8), true)
      assert.equal(jobs.every(({ sourceStartSeq, sourceEndSeq, logEventCount }) => (
        sourceEndSeq >= sourceStartSeq && logEventCount === sourceEndSeq - sourceStartSeq + 1
      )), true)
      for (let index = 1; index < jobs.length; index += 1) {
        assert.ok(jobs[index]!.sourceStartSeq > jobs[index - 1]!.sourceEndSeq, 'completed run log ranges must not overlap')
      }
      assert.equal(stored.prepare("SELECT COUNT(*) AS count FROM ledger_events WHERE source_type = 'dsh-session'").get<{ count: number }>()!.count, 0)
    } finally {
      stored.close()
    }
  } finally {
    composition.stopIngress()
    await adapter.dispose()
    await composition.dispose()
    await questionFiber.dispose()
    readDisposer?.()
    await rm(fixtureRoot, { recursive: true, force: true })
    await rm(dataRoot, { recursive: true, force: true })
  }
})
}
