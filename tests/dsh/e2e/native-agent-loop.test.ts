import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { prepareAgentTask } from '../../../src/akinator/agent-task.js'
import { initializeDatabase } from '../../../src/commands/init.js'
import { openConnection } from '../../../src/db/connection.js'
import { createDshCapabilityCatalog } from '../../../src/dsh/capability-catalog.js'
import { createDshHostAdapter } from '../../../src/dsh/host-adapter.js'
import { mountDshComposition } from '../../../src/dsh/composition.js'
import { submitEnnoAdvice } from '../../../src/enno-oduno/service.js'
import { registerRepositoryAndLocation } from '../../../src/repository/binding.js'
import { compareCanonicalStrings } from '../../../src/serialization/validate.js'
import { STANDARD_SKILL_MANIFESTS } from '../../../src/setup/standard-skills.js'

const dshSourceRoot = process.env.KIOKUKO_DSH_SOURCE_ROOT

function dshModule(relativePath: string): string {
  if (dshSourceRoot === undefined) throw new Error('KIOKUKO_DSH_SOURCE_ROOT is required')
  return pathToFileURL(join(dshSourceRoot, relativePath)).href
}

test('real DSH agent loop resumes persisted state, completes two Enno flows, and handles consecutive lightweight follow-ups', {
  skip: dshSourceRoot === undefined ? 'requires a DeepSeek Harness source checkout' : false,
}, async () => {
  const [cordis, llm, session, projection, systemPrompt, tools, agentRegistry, agentLoop, skills, mock] = await Promise.all([
    import(dshModule('vendor/cordis/lib/index.js')),
    import(dshModule('packages/llm/llm/lib/index.js')),
    import(dshModule('packages/core/session/lib/index.js')),
    import(dshModule('packages/session/session-projection/lib/index.js')),
    import(dshModule('packages/core/system-prompt/lib/index.js')),
    import(dshModule('packages/core/tools/lib/index.js')),
    import(dshModule('packages/core/agent/lib/index.js')),
    import(dshModule('packages/core/agent-loop/lib/index.js')),
    import(dshModule('packages/skill/skill/lib/index.js')),
    import(dshModule('packages/core/agent-loop/tests/mock-adapter.ts')),
  ])
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
    scope: ['src'],
    exclusions: [],
    acceptanceCriteria: [{ id: 'verified', description: 'The final verifier passes.' }],
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
      args: ['--eval', 'process.exit(0)'], cwd: '.', timeoutMs: 5_000,
    }],
    maxAttempts: 3,
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
    ...(failBeforeWork ? [() => { throw new llm.LlmError('WebSocket error', 'PI_AI_ERROR') }] : []),
    mock.toolCallResponse(`work-${suffix}`, 'enno_work_report', workResult),
    ...(retryWork ? [mock.toolCallResponse(`work-${suffix}-retry`, 'enno_work_report', workResult)] : []),
    mock.toolCallResponse(`finish-${suffix}`, 'enno_finish', {
      advisoryDisposition: finalReviewDispositions,
      review: { decision: 'accept', summary: 'All approved work and final verification passed.' },
    }),
    mock.toolCallResponse(`meditation-${suffix}`, 'enno_meditation_submit', {
      meditation: { summary: 'No obsolete tests or functions were found.', inspectedPaths: ['src'], deletionCandidates: [] },
    }),
  ]
  const secondFlow = flowResponses('two')
  const adapterScript = new mock.MockAdapter([
    ...flowResponses('one', true, true, true),
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
  let confirmations = 0
  const confirmationPresentationKinds: string[] = []
  const confirmationSawCompletedPlanResult: boolean[] = []
  const confirmationQuestions: string[] = []
  const confirmationDetails: string[] = []
  let liveAgent: any
  const questionFiber = ctx.plugin({
    name: 'kiokuko-dsh-real-loop-questions',
    apply(questionContext: any) {
      return questionContext.provide('userQuestions', {
        async ask(request: any) {
          assert.equal(request.agent, liveAgent, 'every user question must use the exact live DSH Agent scope')
          const question = request.questions[0]
          if (question.id === 'kiokuko-plan-confirmation') {
            confirmations += 1
            confirmationPresentationKinds.push(question.intent?.kind ?? 'generic')
            confirmationQuestions.push(question.question)
            confirmationDetails.push(question.detail)
            const expectedPlanCall = ['plan-one', 'plan-two', 'plan-two-revised'][confirmations - 1]
            confirmationSawCompletedPlanResult.push(liveAgent.session.snapshotEvents().some((event: any) => (
              event.type === 'tool/result'
              && event.data.message.content[0]?.toolCallId === expectedPlanCall
            )))
            assert.deepEqual(question.options.map((option: any) => option.label), ['approve', 'cancel'])
            if (confirmations === 2) {
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
        .map((tool: any) => ({ kind: 'mcp_tool', name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }) }))
        .sort((left: any, right: any) => compareCanonicalStrings(left.name, right.name)),
    })
    let seededRunId = ''
    await adapter.host.runtime!.withDatabase(async (seedDatabase) => {
      const seeded = await prepareAgentTask(seedDatabase, {
        requestId: 'pre-reload-active-run',
        task: '@PLAN.md を実装',
        cwd: fixtureRoot,
        profileHints: { taskType: 'build', target: fixtureRoot, expected: '@PLAN.md を実装' },
        capabilities: [...recoveryCatalog.skills, ...recoveryCatalog.tools],
        client: { kind: 'dsh', sessionId: liveAgent.session.id },
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
    const completeTurn = async (task: string): Promise<void> => {
      const idle = new Promise<void>((resolve) => {
        const dispose = ctx.on('agent/status', ({ agent, status }: { agent: unknown; status: string }) => {
          if (agent === liveAgent && status === 'idle') {
            dispose()
            resolve()
          }
        })
      })
      liveAgent.followup(llm.createUserMessage({
        content: [{ type: 'text', text: task }],
        source: { kind: 'user' },
      }))
      await idle
      const close = await adapter.host.resolveIdleClose!(
        liveAgent.id,
        liveAgent.session.id,
        liveAgent.session,
        liveAgent,
      )
      if (close !== undefined) await adapter.host.lifecycle!.closeTurn(close)
    }
    await completeTurn('@PLAN.md を実装')
    const interrupted = openConnection(databasePath)
    try {
      interrupted.prepare(`
        UPDATE enno_execution_leases
        SET lease_expires_at = '2000-01-01T00:00:00.000Z'
        WHERE run_id = ?
      `).run(seededRunId)
    } finally {
      interrupted.close()
    }
    await completeTurn('止まった WorkUnit から再開してください。')
    await completeTurn('@PLAN.md の残りを実装')
    await completeTurn('計画を src のみに絞って再提出してください。')
    await completeTurn('all fixed?')
    await completeTurn('gimme commit message.')

    const toolEvents = liveAgent.session.snapshotEvents().filter((event: any) => event.type.startsWith('tool/'))
    const results = toolEvents.filter((event: any) => event.type === 'tool/result')
    const turnEnds = liveAgent.session.snapshotEvents().filter((event: any) => event.type === 'turn/end')
    const longAssistantMessage = liveAgent.session.snapshotEvents().find((event: any) => (
      event.type === 'assistant/message' && event.sourceEventSeqs?.length > 2_048
    ))
    assert.ok(longAssistantMessage, 'the real loop must exercise a source sequence list larger than the former bridge limit')
    assert.deepEqual(results.map((event: any) => event.data.message.content[0]?.isError), Array(12).fill(false), JSON.stringify({ toolEvents, turnEnds }))
    const failedFocusedReport = results.find((event: any) => event.data.message.content[0]?.toolCallId === 'work-one')
    const failedFocusedPayload = JSON.parse(failedFocusedReport?.data.message.content[0]?.content[0]?.text ?? '{}')
    assert.equal(failedFocusedPayload.verifierResults?.[0]?.status, 'failed')
    assert.equal(failedFocusedPayload.ennoOduno?.nextAction, 'execute_work_unit')
    assert.equal(failedFocusedPayload.executionLease?.workUnitId, 'implement-plan')
    assert.equal(results.some((event: any) => event.data.message.content[0]?.toolCallId === 'work-one-retry'), true)
    assert.equal(turnEnds.length, 6)
    assert.deepEqual(turnEnds[0]?.data.reason, {
      kind: 'error',
      error: { message: 'WebSocket error', code: 'PI_AI_ERROR' },
    })
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
    assert.equal(injectedTexts.some((text: string) => /Finalized intake:[\s\S]*PLAN\.md/u.test(text)), true)
    assert.equal(injectedTexts.some((text: string) => /止まった WorkUnit から再開してください/u.test(text)), true)
    assert.equal(injectedTexts.some((text: string) => /Finalized intake:[\s\S]*all fixed\?/u.test(text)), true)
    assert.match(injectedTexts.at(-1) ?? '', /Finalized intake:[\s\S]*gimme commit message/u)
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
      for (const row of runRows) {
        const eventTypes = stored.prepare(`
          SELECT payload_json AS payloadJson
          FROM ledger_events
          WHERE run_id = ? AND source_type = 'dsh-session'
          ORDER BY source_sequence
        `).all<{ payloadJson: string }>(row.runId).map(({ payloadJson }) => (
          (JSON.parse(payloadJson) as { event: { type: string } }).event.type
        ))
        assert.equal(eventTypes.includes('turn/start'), true, 'the pre-binding turn prefix must reach the exact run ledger')
        assert.equal(eventTypes.includes('tool/result'), true, 'successful terminal tool results must reach the run ledger')
        assert.equal(eventTypes.includes('turn/end'), true, 'native session flush must precede terminal ledger close')
      }
    } finally {
      stored.close()
    }
  } finally {
    composition.stopIngress()
    await adapter.dispose()
    await composition.dispose()
    await questionFiber.dispose()
    await rm(fixtureRoot, { recursive: true, force: true })
    await rm(dataRoot, { recursive: true, force: true })
  }
})
