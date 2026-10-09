import assert from 'node:assert/strict'
import test from 'node:test'
import { confirm } from '../../../../src/dsh/lisp/approval.js'

const question = { id: 'apply', question: 'Apply?', options: [{ label: 'No' }, { label: 'Yes' }], intent: { kind: 'plan-review' as const, approve: 'Yes' } }
test('profile policy approves without questions and still validates identity', async () => {
  let asks = 0, validations = 0
  const questions = { ask: async () => { asks++; throw new Error('must not ask') }, approvalPolicy: {
    mode: () => 'auto' as const, writable: () => false,
    validate: () => { validations++ }, set: async () => {},
  } }
  assert.equal((await confirm(questions, 'agent', question, new AbortController().signal)).approved, true)
  assert.equal(asks, 0); assert.equal(validations, 1)
  questions.approvalPolicy.validate = () => { throw new Error('wrong session') }
  await assert.rejects(confirm(questions, 'agent', question, new AbortController().signal), /wrong session/)
  assert.equal((await confirm(questions, 'agent', question, AbortSignal.abort())).approved, false)
})
test('enable and continue persists once; failed persistence never approves', async () => {
  let mode: 'ask' | 'auto' = 'ask', saves = 0
  const questions = { ask: async (request: any) => ({ answers: [{ id: 'apply', selected: [request.questions[0].options.at(-1).label] }] as const }), approvalPolicy: {
    mode: () => mode, writable: () => true, validate: () => {},
    set: async () => { saves++; mode = 'auto' },
  } }
  assert.equal((await confirm(questions, 'agent', question, new AbortController().signal)).approved, true)
  assert.equal(saves, 1); assert.equal(mode, 'auto')
  mode = 'ask'; questions.approvalPolicy.set = async () => { throw new Error('disk full') }
  assert.equal((await confirm(questions, 'agent', question, new AbortController().signal)).approved, false)
})

test('cancellation during persistence cannot authorize the pending operation', async () => {
  const controller = new AbortController()
  const questions = { ask: async (request: any) => ({ answers: [{ id: 'apply', selected: [request.questions[0].options.at(-1).label] }] as const }), approvalPolicy: {
    mode: () => 'ask' as const, writable: () => true, validate: () => {}, set: async () => { controller.abort() },
  } }
  assert.deepEqual(await confirm(questions, 'agent', question, controller.signal), { approved: false, reason: 'cancelled' })
})

test('read-only profile never offers or accepts enable-and-continue', async () => {
  const questions = { ask: async (request: any) => {
    assert.equal(request.questions[0].options.length, 2)
    return { answers: [{ id: 'apply', selected: ['Auto-approve all Lisp actions for this profile and continue'] }] as const }
  }, approvalPolicy: { mode: () => 'ask' as const, writable: () => false, validate: () => {}, set: async () => { throw new Error('must not save') } } }
  assert.deepEqual(await confirm(questions, 'agent', question, new AbortController().signal), { approved: false, reason: 'invalid_answer' })
})

for (const mode of ['ask', 'auto'] as const) test(`${mode} configured policy works without persistence`, async () => {
  const { mountApprovalPolicy } = await import('../../../../src/dsh/lisp/approval-settings.js')
  const policy = mountApprovalPolicy({ get: () => undefined } as any, mode, () => {})
  assert.equal(policy.mode(), mode); assert.equal(policy.writable(), false)
  await assert.rejects(policy.set('auto'), /unavailable or read-only/)
})

test('ask retains denial, unavailable UI, malformed answers and timeout', async () => {
  const signal = new AbortController().signal
  assert.deepEqual(await confirm(undefined, 'a', question, signal), { approved: false, reason: 'unavailable' })
  for (const [selected, reason] of [[['No'], 'declined'], [['Yes', 'No'], 'invalid_answer'], [['anything'], 'invalid_answer']] as const) {
    assert.deepEqual(await confirm({ask: async () => ({answers:[{id:'apply',selected}]})}, 'a', question, signal), {approved:false,reason})
  }
  assert.deepEqual(await confirm({ask: async () => new Promise(()=>{})}, 'a', question, signal, 5), {approved:false,reason:'timed_out'})
})

 test('automatic policy receives the frozen session and workspace identity', async () => {
  const owner = {agentId:'a',sessionId:'s',root:'/trusted'}
  const questions = {ask:async()=>{throw new Error('must not ask')},approvalPolicy:{
    mode:()=>'auto' as const,writable:()=>false,set:async()=>{},
    validate:(id:string,actual?:typeof owner)=>{assert.equal(id,'a');assert.deepEqual(actual,owner)},
  }}
  assert.deepEqual(await confirm(questions,owner,question,new AbortController().signal),{approved:true,source:'profile'})
})
