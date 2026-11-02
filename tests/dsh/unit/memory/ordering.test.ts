import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDshMessageSources } from '../../../../src/dsh/message-sources.js'
import { injectDshContext } from '../../../../src/dsh/context-injection.js'
import type { PreparedAgentTask } from '../../../../src/dsh/task-intake.js'

function prepared(memoryPolicy: { memoryReasoningRequired: boolean; contextWithheld: boolean }): PreparedAgentTask {
  return {
    intake: { status: 'ready', profile: { taskType: 'build', target: null, expected: 'tests pass', constraints: null } },
    nextAction: 'proceed',
    memoryPolicy,
    context: { untrusted: true, items: [{ title: 'Prior', summary: null, bodyPreview: 'Use the verified repository evidence.', selectionReasons: ['word_match'] }] },
  } as unknown as PreparedAgentTask
}

test('withheld memory never reaches the model without memory-reasoning', async () => {
  const messages = await injectDshContext({
    prepared: prepared({ memoryReasoningRequired: true, contextWithheld: true }),
    task: 'Continue from current evidence.',
  })
  assert.deepEqual(messages.map((message) => message.source), ['soul', 'user-task'])
})

for(const intakeStatus of ['ready','exhausted'] as const)for(const memoryReasoningRequired of [false,true])for(const contextWithheld of [false,true])test(`memory source ordering: ${intakeStatus}, reasoning=${memoryReasoningRequired}, withheld=${contextWithheld}`,async()=>{
  const value=prepared({memoryReasoningRequired,contextWithheld})
  const sources=await buildDshMessageSources({task:'The exact current request',intakeStatus,nextAction:'proceed',memoryPolicy:value.memoryPolicy,context:value.context})
  assert.equal(sources[0]!.kind,'soul');assert.equal(sources[0]!.trust,'system')
  assert.equal(sources.at(-1)!.kind,'user-task');assert.equal(sources.at(-1)!.trust,'user');assert.equal(sources.at(-1)!.text,'The exact current request')
  const reasoning=sources.findIndex(source=>source.kind==='memory-reasoning'),memories=sources.filter(source=>source.kind==='memory')
  assert.equal(reasoning>=0,memoryReasoningRequired&&!contextWithheld)
  assert.equal(memories.length>0,!contextWithheld)
  for(const memory of memories){assert.equal(memory.trust,'untrusted');if(reasoning>=0)assert.ok(sources.indexOf(memory)>reasoning);assert.ok(sources.indexOf(memory)<sources.length-1)}
})
