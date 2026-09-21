import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { stringify } from 'yaml'
import { requestLaya } from '../dist/dsh/decisions/laya-transport.js'
import { LayaCoreMLDecisionProvider, parseLayaHealth, discoverLayaConfiguration } from '../dist/dsh/decisions/laya-coreml.js'
import { TypeSafeDecisionProvider } from '../dist/dsh/decisions/providers.js'
import { mountDecisionCommand } from '../dist/dsh/decisions/host.js'
import { TypedDecisionsConfig, resolveDecisionConfiguration, LAYA_SOCKET } from '../dist/dsh/decisions/config.js'
import { DecisionService } from '../dist/dsh/decisions/service.js'

const { values } = parseArgs({ options: { live: { type: 'boolean' }, socket: { type: 'string', default: LAYA_SOCKET }, 'print-config': { type: 'boolean' } } })
if (!values.live) {
  console.error('Explicit invocation required: node scripts/smoke-laya-coreml.mjs --live [--print-config] [--socket PATH]')
  process.exit(1)
}
const path = values.socket.startsWith('~/') ? resolve(homedir(), values.socket.slice(2)) : resolve(values.socket)
const signal = AbortSignal.timeout(15000)
try {
  const runtime = parseLayaHealth(await requestLaya(path, '{"version":1,"op":"health"}', signal, 5000))
  const settings = { socketPath: values.socket, model: runtime.model, runtimeFingerprint: runtime.runtimeFingerprint, timeoutMs: 5000, acceptance: { minProbability: .9, minMargin: .2 } }
  const config = resolveDecisionConfiguration(TypedDecisionsConfig.parse({ provider: 'laya-coreml', 'laya-coreml': settings }), process.cwd())
  if (values['print-config']) {
    console.log(stringify({ typedDecisions: { mode: 'auto', provider: 'laya-coreml', 'laya-coreml': settings } }))
  } else {
    const automatic = TypedDecisionsConfig.parse({ 'laya-coreml': { socketPath: path } })
    const service = new DecisionService(automatic, c => c.provider === 'laya-coreml' ? new LayaCoreMLDecisionProvider(c['laya-coreml']) : new TypeSafeDecisionProvider(c.typesafe, async () => { throw new Error('No cloud requests in this smoke') }), undefined,
      { resolveConfiguration: (c, signal) => discoverLayaConfiguration(c, process.cwd(), signal) })
    let command
    mountDecisionCommand({ register: definition => { command = definition; return () => {} } }, service)
    assert.equal((await command.handler({ rawInput: 'use laya', signal })).kind, 'success', 'automatic Laya selection failed')
    const provider = new LayaCoreMLDecisionProvider((await service.bind('synthetic-laya-smoke', signal))['laya-coreml'])
    const readiness = await service.probe(signal)
    assert.equal(readiness.state, 'ready', 'synthetic readiness probe rejected')
    const batch = { purpose: 'lisp', state: 'The count is three.', questions: [{ id: 'count', instructions: 'Which count is stated?', choices: [{ id: 'three', description: 'Three' }, { id: 'one', description: 'One' }, { id: 'unknown', description: 'Unknown' }], abstainId: 'unknown' }] }
    await provider.preflight(batch, signal)
    const result = await service.evaluate('synthetic-laya-smoke', batch, signal)
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.result.answers, [{ id: 'count', status: 'selected', choiceId: 'three' }])
    await assert.rejects(provider.preflight({ ...batch, state: 'Complete evidence. '.repeat(2000) }, signal), { code: 'DECISION_TOO_LARGE' })
    const wrong = new LayaCoreMLDecisionProvider({ ...config['laya-coreml'], runtimeFingerprint: `sha256:${'0'.repeat(64)}` })
    await assert.rejects(wrong.evaluate(batch, signal), { code: 'DECISION_UNSUPPORTED' })
    const legacy = await requestLaya(path, JSON.stringify({ version: 1, op: 'predict', state: 'The fruit is apple.', questions: { fruit: { type: 'noul', instructions: 'Is the fruit apple?' } } }), signal, 5000)
    assert.equal(legacy.version, 1); assert.equal(legacy.ok, true); assert.equal(legacy.result.answers.fruit.type, 'noul')
    console.log(JSON.stringify({ live: true, automaticSelection: true, readiness: readiness.state, result, capacityRejection: true, fingerprintRejection: true, legacyNoul: true,
      note: 'Synthetic interoperability checks only; no accuracy or latency benchmark.' }, null, 2))
  }
} catch (error) {
  const code = typeof error?.code === 'string' && /^DECISION_[A-Z_]+$/.test(error.code) ? error.code : 'SMOKE_FAILED'
  console.error(`Laya smoke failed (${code}). The worker must support preflight/predict_strict. No retry or worker restart was made.`)
  process.exitCode = 1
}
