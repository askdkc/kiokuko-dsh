import assert from 'node:assert/strict'
import test from 'node:test'
import { Config } from '../../../src/dsh/config.js'
import { StartupDefaultsConfig } from '../../../src/dsh/startup-defaults.js'
import { isDefaultOption, startupOptionLabel, stripRecommendedSuffix } from '../../../src/dsh/startup-defaults-settings.js'
import { TASK_STARTUP_OPTIONS, parseTaskStartupAnswer } from '../../../src/dsh/task-startup.js'
import { nativeLiveConfig, bindLiveConfig, STARTUP_DECISION_PATH, DECISION_PROVIDER_PATH } from '../../../src/dsh/live-config.js'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { STARTUP_DEFAULTS_SERVICE } from '../../../src/dsh/startup-defaults.js'
import { DECISION_PROVIDER_SERVICE } from '../../../src/dsh/live-config.js'

test('startup defaults default to ask and reject unknown modes', () => {
  assert.deepEqual(StartupDefaultsConfig.parse({}), { decision: 'ask', lisp: 'ask' })
  assert.throws(() => StartupDefaultsConfig.parse({ decision: 'always' }))
  assert.throws(() => StartupDefaultsConfig.parse({ decision: 'on', extra: true }))
  // An omitted section must parse to the neutral default rather than enabling anything.
  assert.deepEqual(Config.parse({}).startupDefaults, { decision: 'ask', lisp: 'ask' })
})

test('card options carry the preset marker only for the configured pair', () => {
  assert.equal(isDefaultOption('ask', 'ask', 0), false, 'no preset marks nothing')
  assert.equal(isDefaultOption('on', 'on', 0), true)
  assert.equal(isDefaultOption('on', 'on', 3), false)
  assert.equal(isDefaultOption('on', 'off', 1), true)
  assert.equal(isDefaultOption('off', 'on', 2), true)
  assert.equal(isDefaultOption('off', 'off', 3), true)
  assert.equal(isDefaultOption('on', 'off', 4), false, 'cancel is never the preset')
  // Exactly one option is marked for each configured pair.
  for (const decision of ['on', 'off'] as const) for (const lisp of ['on', 'off'] as const)
    assert.equal([0, 1, 2, 3].filter(index => isDefaultOption(decision, lisp, index)).length, 1)
})

test('the preset label marker is presentation only and round-trips', () => {
  const marked = startupOptionLabel(TASK_STARTUP_OPTIONS[0]!, true)
  assert.equal(marked, 'decision ON / Lisp ON (Recommended)')
  assert.equal(startupOptionLabel(TASK_STARTUP_OPTIONS[0]!, false), 'decision ON / Lisp ON')
  assert.equal(stripRecommendedSuffix(marked), 'decision ON / Lisp ON')
  assert.equal(stripRecommendedSuffix('decision ON / Lisp ON'), 'decision ON / Lisp ON')
  // A marked answer still resolves to the same immutable choice.
  const base = { answers: [{ id: 'q', selected: [TASK_STARTUP_OPTIONS[1]!] }] }
  const presellected = { answers: [{ id: 'q', selected: [startupOptionLabel(TASK_STARTUP_OPTIONS[1]!, true)] }] }
  assert.deepEqual(parseTaskStartupAnswer(presellected, 'q'), parseTaskStartupAnswer(base, 'q'))
  assert.deepEqual(parseTaskStartupAnswer(presellected, 'q'), { decision: true, lisp: false })
  // Cancel and Skip stay unambiguous.
  assert.deepEqual(parseTaskStartupAnswer({ answers: [{ id: 'q', selected: [startupOptionLabel(TASK_STARTUP_OPTIONS[4]!, true)] }] }, 'q'),
    { decision: false, lisp: false, cancelled: true })
  assert.deepEqual(parseTaskStartupAnswer({ answers: [{ id: 'q', selected: [] }] }, 'q'), { decision: false, lisp: false, cancelled: true })
})

test('the native settings form exposes the new defaults and provider behind sibling config', () => {
  const schema = nativeLiveConfig(Config)
  const services: Record<string, any> = {}
  const ctx: any = { fiber: { entry: { options: { id: 'kiokuko-dsh' } } }, get: (name: string) => services[name], provide: (name: string, value: any) => { services[name] = value } }
  const resolved: any = schema({ enabled: true, lisp: { enabled: true, sbclPath: 'sbcl', maxWorkers: 3 },
    typedDecisions: { mode: 'off', typesafe: { model: 'jev-latest' } }, startupDefaults: { decision: 'on', lisp: 'off' } })
  // Untouched siblings survive the live wrapper.
  assert.equal(resolved.lisp.enabled, true)
  assert.equal(resolved.lisp.maxWorkers, 3)
  assert.equal(resolved.typedDecisions.mode, 'off')
  assert.equal(resolved.typedDecisions.typesafe.model, 'jev-latest')
  // Configured values are live references until bound.
  updateVolatile(resolved.startupDefaults.decision, createVolatile('off'))
  const plain = Config.parse(bindLiveConfig(ctx, resolved))
  assert.deepEqual(plain.startupDefaults, { decision: 'off', lisp: 'off' })
  assert.equal(plain.typedDecisions.provider, 'typesafe')
  assert.equal(plain.lisp.enabled, true)
  // The running plugin reads the same live sources.
  assert.equal(services[STARTUP_DEFAULTS_SERVICE].decision(), 'off')
  assert.equal(services[STARTUP_DEFAULTS_SERVICE].lisp(), 'off')
  assert.equal(services[DECISION_PROVIDER_SERVICE].configured(), 'typesafe')
  // Editing the provider through the form changes what later requests use.
  updateVolatile(resolved.typedDecisions.provider, createVolatile('openai'))
  assert.equal(Config.parse(bindLiveConfig(ctx, resolved)).typedDecisions.provider, 'openai')
  assert.equal(services[DECISION_PROVIDER_SERVICE].configured(), 'openai')
  // Paths are the contract the settings control writes to.
  assert.deepEqual(STARTUP_DECISION_PATH.path, ['startupDefaults', 'decision'])
  assert.deepEqual(DECISION_PROVIDER_PATH.path, ['typedDecisions', 'provider'])
})
