import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDshMessageSources } from '../../../src/dsh/message-sources.js'
import { injectDshContext, selectDshDirectiveSources } from '../../../src/dsh/context-injection.js'
import { DshEnnoController } from '../../../src/dsh/enno-controller.js'
import { createStandardSkillProvider } from '../../../src/dsh/standard-skill-provider.js'
import type { EnnoOdunoState } from '../../../src/enno-oduno/types.js'
import type { PreparedAgentTask } from '../../../src/dsh/task-intake.js'

const admitted = {
  task: 'Fix the reported bug.', intakeStatus: 'ready', nextAction: 'proceed',
  memoryPolicy: { memoryReasoningRequired: true, contextWithheld: false }, context: null,
} as const

test('every advertised bundled Skill can be routed into model context with its exact provider content', async () => {
  const provider = createStandardSkillProvider()
  try {
    const listed = await provider.list({})
    const candidates = 'candidates' in listed ? listed.candidates : listed
    const sources = await buildDshMessageSources({ ...admitted, routeSkillNames: candidates.map(skill => skill.name) })
    for (const candidate of candidates) {
      const definition = await provider.get(candidate, {})
      assert.ok(definition)
      const source = sources.find(item => item.name === candidate.name)
      assert.ok(source, candidate.name)
      assert.ok(source.text.includes(definition.content), candidate.name)
      assert.equal(source.trust, 'system')
    }
    assert.equal(sources.at(-1)?.kind, 'user-task')
  } finally { provider.dispose() }
})

test('Zenki continuation injects the Japanese Skill instead of aborting context assembly', async () => {
  const state = {
    applicable: true, status: 'zenki_planning', orchestrationId: 'orch', dshSessionId: 'session',
    contractRevision: 3, routeEpoch: 0, currentRole: 'zenki', nextAction: 'submit_plan',
    directive: {
      protocolVersion: 1, runId: 'run', contractRevision: 3, routeEpoch: 0, role: 'zenki',
      instructions: [], handoff: null, objective: 'Submit a plan',
      requiredSkills: ['kiokuko-soul', 'kiokuko-single-purpose-functions', 'natural-japanese-output'],
      workUnit: null, stopConditions: ['Submit one plan'], reportSchema: {},
    },
    advisoryPhaseState: { state: 'not_started' },
  } as unknown as EnnoOdunoState
  const prepared = {
    intake: { status: 'ready', profile: { target: null, expected: null, constraints: null } },
    nextAction: 'proceed', memoryPolicy: admitted.memoryPolicy, context: null,
  } as unknown as PreparedAgentTask
  const messages: Awaited<ReturnType<typeof injectDshContext>>[number][] = []
  let steers = 0
  const cancels: string[] = []
  const controller = new DshEnnoController({
    readState: async () => state,
    injectNextStepContext: async ({ selection }) => {
      assert.deepEqual(selection, selectDshDirectiveSources(state.directive!))
      messages.push(...await injectDshContext({ prepared, task: admitted.task, directive: state.directive!, ...selection }))
    },
  })
  const result = await controller.handle({
    agent: { id: 'session', steer: () => { steers++ }, cancel: reason => { cancels.push(reason) } },
    turn: 1, signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'steer')
  assert.equal(steers, 1)
  assert.deepEqual(cancels, [])
  assert.match(messages.find(item => item.name === 'natural-japanese-output')?.content ?? '', /name: natural-japanese-output/u)
})

test('nonbundled route Skills produce degraded guidance without stopping the admitted task', async () => {
  const sources = await buildDshMessageSources({ ...admitted, routeSkillNames: ['project-local-skill'] })
  const warning = sources.find(source => source.name === 'project-local-skill')
  assert.match(warning?.text ?? '', /SKILL_NOT_BUNDLED/u)
  assert.match(warning?.text ?? '', /degraded/u)
  assert.match(warning?.text ?? '', /native Skill tool/u)
  assert.equal(sources.at(-1)?.text, admitted.task)
})

test('routed Skill lookup does not infer filesystem paths or weaken expert validation', async () => {
  const sources = await buildDshMessageSources({ ...admitted, routeSkillNames: ['japanese-translation-for-oss-models', '../../package.json'] })
  assert.ok(sources.filter(source => source.kind === 'route-skill').every(source => source.text.includes('SKILL_NOT_BUNDLED')))
  for (const reference of [
    { skillName: 'kiokuko-soul', relativePath: '../SKILL.md' },
    { skillName: 'kiokuko-single-purpose-functions', relativePath: 'references/../../package.json' },
    { skillName: 'natural-japanese-output', relativePath: 'references/missing.md' },
  ]) {
    await assert.rejects(buildDshMessageSources({ ...admitted, expertRefs: [reference] }), /Invalid bundled expert path|Bundled Skill file is unavailable/u)
  }
})
