import { executeNativeTool, mountNativeTools } from '../helpers/native-tools.js'
/** Real published DSH tool registry and local Bash implementation. Only host
 * admission is doubled so one recoverable preparation error is deterministic. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { OnDemandIntake, TASK_PREPARE_TOOL } from '../../../src/dsh/on-demand-intake.js'
import { createRequestIntentContext, requestIntentReferenceIds, requestIntentMessageRefs, bindMainModelRequestIntent } from '../../../src/dsh/decisions/request-intent.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const load = (name: string) => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)
const signal = () => new AbortController().signal
for (const mode of ['automatic', 'retry', 'unowned', 'authority-unavailable', 'authority-changed', 'authority-lost-after-permission', 'explicit-deferred'] as const) test(`native Bash without formal Goal or manual preparation: ${mode}`, { timeout: 30_000 }, async () => {
  const retry = mode === 'retry', deferredOnly = mode === 'explicit-deferred', native = !['automatic', 'retry', 'explicit-deferred'].includes(mode)
  let ownershipLookups = 0, optionalCalls = 0
  const root = await mkdtemp(join(tmpdir(), 'nonblocking-native-prepare-'))
  const [cordis, sessions] = await Promise.all([load('cordis'), load('dsh-session')])
  const ctx = new cordis.Context(), fibers: any[] = []
  let intake: OnDemandIntake | undefined, prepared = false, attempts = 0, calls = 0
  try {
    for (const name of ['dsh-system-prompt', 'dsh-session-projection', 'dsh-tools', 'dsh-fs-local', 'dsh-working-directory', 'dsh-subprocess-local', 'dsh-bash-local', 'dsh-shell-env', 'dsh-tool-bash']) {
      const plugin = await load(name)
      const config = name === 'dsh-fs-local' || name === 'dsh-bash-local' ? { cwd: root }
        : name === 'dsh-working-directory' ? { defaultDirectory: root }
          : name === 'dsh-shell-env' ? { dshHome: root } : {}
      if (name === 'dsh-tools') await mountNativeTools(ctx, plugin, packages, fibers)
      else fibers.push(await ctx.plugin(plugin.default ?? plugin, config))
    }
    const session = sessions.Session.create(sessions.SessionId('nonblocking-retry'), [], { version: 4, id: 'nonblocking-retry', createdAt: 1, isSeeded: false, cwd: root })
    const agent = { id: 'nonblocking-agent', session, ctx }
    const task = 'Continue inspecting the current local shell environment with printf; do not edit project files.'
    const messages = [{ id: 'human-request', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: task }] }]
    const context = createRequestIntentContext({ task, messageRefs: requestIntentMessageRefs(messages, task) })!
    const requestIntent = { relation: 'same_scope_continuation', action: 'research', evidenceRefs: requestIntentReferenceIds(context) }
    // A first new/research interpretation isolates the retry assertion from the
    // separately tested Goal-less continuation validator.
    const initial = bindMainModelRequestIntent({ ...requestIntent, relation: 'new' }, context)!
    intake = new OnDemandIntake({ validate: async input => { assert.equal(input.agent, agent) }, existing: async () => false,
      ...(native ? { nativeOwnership: async () => {
        ownershipLookups++
        if (mode === 'authority-unavailable' && ownershipLookups > 1 || mode === 'authority-lost-after-permission' && ownershipLookups > 2) throw new Error('Authority ledger unavailable')
        return mode === 'authority-changed' && ownershipLookups > 1 ? 'owned' as const : 'unowned' as const
      }, answerContext: { retire() {}, async prepare() { optionalCalls++; throw new Error('Optional memory database/provider unavailable') } } as any } : {}),
      classify: async () => { optionalCalls++; return { ...(deferredOnly ? {} : { taskType: 'research' as const }), deferInference: deferredOnly } },
      ...(deferredOnly ? {} : { interpret: async () => { optionalCalls++; return { context, decision: initial } } }),
      prepare: async () => { attempts++; if (retry && attempts === 1) throw new Error('Transient preparation failure'); prepared = true; return true },
      ready: candidate => candidate === agent && prepared,
    }, { onlyWhenDeferred: deferredOnly })
    intake.mount(ctx, ctx.tools)
    const humanStop = new AbortController()
    await assert.doesNotReject(intake.capture({ agent, turn: 1, step: 0, messages, signal: humanStop.signal }), 'optional memory preparation is not execution authority')
    const execute = (name: string, args: object) => executeNativeTool(ctx, packages, { callId: `nonblocking-${++calls}`, name, arguments: args, agent, signal: signal() })
    const command = { command: 'printf NATIVE_BASH_REACHED', description: 'Inspect fixed harmless command output' }
    if (retry) {
      const failed = await execute(TASK_PREPARE_TOOL, { requestIntent: { ...requestIntent, relation: 'new' } })
      assert.equal(failed.isError, true); assert.match(JSON.stringify(failed), /Transient preparation failure/)
      assert.equal(intake.snapshot(session.id)!.status, 'answer', 'recoverable failure must not poison captured human authority')
      const corrected = await execute(TASK_PREPARE_TOOL, { requestIntent })
      assert.equal(corrected.isError, false, JSON.stringify(corrected))
    }
    if (deferredOnly) {
      assert.equal((await execute('bash', command)).isError, true, 'explicit deferred-only intake still requires preparation')
      assert.equal(attempts, 0)
      assert.equal((await execute(TASK_PREPARE_TOOL, { taskType: 'research' })).isError, false)
    }
    const ownershipBefore = ownershipLookups, optionalBefore = optionalCalls
    const result = await execute('bash', command)
    assert.equal(ownershipLookups, ownershipBefore, 'optional owner metadata is not re-read as native permission')
    assert.equal(optionalCalls, optionalBefore, 'ordinary native dispatch needs no additional classification or memory calls')
    if (native) assert.equal(optionalCalls, 0, 'neither optional memory failure nor classifier availability gates native work')
    assert.equal(result.isError, false, JSON.stringify(result)); assert.match(JSON.stringify(result.content), /NATIVE_BASH_REACHED/)
    assert.equal(attempts, retry ? 2 : deferredOnly ? 1 : 0)
    const deniedFile = join(root, 'must-not-exist')
    const deny = ctx.tools.guard((execution: any) => execution.name === 'bash' ? 'Native Bash permission denied' : undefined)
    try { assert.equal((await execute('bash', { ...command, command: `printf forbidden > ${JSON.stringify(deniedFile)}` })).isError, true) } finally { deny() }
    humanStop.abort(new Error('Explicit native human Stop'))
    assert.equal((await execute('bash', { ...command, command: `printf forbidden > ${JSON.stringify(deniedFile)}` })).isError, true)
    await assert.rejects(readFile(deniedFile), { code: 'ENOENT' })
  } finally {
    await intake?.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
