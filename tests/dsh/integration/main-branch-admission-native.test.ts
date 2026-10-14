import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { openConnection } from '../../../src/db/connection.js'
import { readExecutionOwner } from '../../../src/dsh/orchestration/execution-owner.js'
import { interpretedPreparation, toolValue } from '../helpers/coding-script.js'
import { nativeToolResults } from '../helpers/native-mock.js'
import { nativeSkillFixture } from '../helpers/skill-native.js'
import { withIsolatedSkillHome } from '../helpers/skill-home.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const packageRoot = process.env.KIOKUKO_TEST_PLUGIN_PACKAGE_ROOT
const nativeAvailable = existsSync(join(packages, '@deepseek-ai/dsh/package.json'))
if (!nativeAvailable && (process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1' || process.env.KIOKUKO_DSH_PACKAGE_ROOT !== undefined)) {
  throw new Error('Main conversation branch admission coverage requires the native DSH runtime')
}

test('a seeded main conversation branch admits work and executes kioku_read through the public native plugin', { skip: nativeAvailable ? false : 'requires the packaged DSH runtime', timeout: 30_000 }, async () => withIsolatedSkillHome(async () => {
  const session = await import(pathToFileURL(join(packages, '@deepseek-ai/dsh-session/lib/index.js')).href)
  const f = await nativeSkillFixture({ packages, ...(packageRoot ? { packageRoot } : {}), explicit: false, extra: {
    lisp: { enabled: false }, typedDecisions: { mode: 'off' }, answerReview: { mode: 'off' },
    memoryReuse: { mode: 'off' }, memoryReview: { mode: 'off' }, memoryEvolution: { mode: 'off' },
    memoryIndexReasoning: { mode: 'off' }, semanticCompaction: { mode: 'off' }, modelAutoMode: { mode: 'off' },
    toolExposure: { mode: 'full' },
  } })
  let branch: any
  const errors: unknown[] = []
  const disposeErrors = f.ctx.on('agent/error', (event: any) => errors.push(event.error))
  const marker = 'BRANCH_ADMITTED_FILE_CONTENT'
  const task = 'PLAN.md を読んで内容を説明してください。ファイルは変更しないで。'
  let observedOwner = false
  try {
    await writeFile(join(f.dir, 'PLAN.md'), marker)
    f.responses.push(f.mock.textResponse('Earlier conversation completed.'))
    await f.turn('簡単に挨拶してください。')
    const seed = structuredClone(f.agent.session.snapshotEvents())
    assert.ok(seed.some((event: any) => event.type === 'turn/end'))
    // dsh-cli liveSessionCreateOptions uses this exact seeded-continuation shape
    // for model changes and rewinds; parentSession records lineage, not delegation.
    branch = await f.ctx.agents.create({
      sessionId: session.SessionId('main-conversation-branch'), seed,
      inheritedEventCount: session.SessionLogOffset(seed.length),
      meta: { cwd: f.dir, parentSession: f.agent.session.id, isSeeded: true },
      agentOptions: { provider: 'mock', model: 'qwen3-coder' },
    })
    assert.equal(branch.agent.session.header.parentSession, f.agent.session.id)
    assert.equal(branch.agent.session.header.origin, undefined)
    assert.equal(branch.agent.session.header.delegationDepth, undefined)
    const ownStart = branch.agent.session.seq
    f.responses.push(
      interpretedPreparation(f.mock, 'prepare-branch', 'new', 'research', 'research'),
      (request: any) => {
        const prepared = toolValue(request, 'prepare-branch')
        assert.equal(prepared.prepared, true)
        assert.equal(prepared.originalTask, task)
        const db = openConnection(join(f.dir, 'kiokuko-dsh.sqlite3'))
        try {
          const owner = readExecutionOwner(db, branch.agent.session.id)
          assert.ok(owner, 'the continuation must own an admitted execution before reading')
          const run = db.prepare('SELECT status FROM ledger_runs WHERE run_id = ?').get<{ status: string }>(owner.run_id)
          assert.equal(run?.status, 'active')
          observedOwner = true
        } finally { db.close() }
        return f.mock.toolCallResponse('read-branch', 'kioku_read', { path: 'PLAN.md' })
      },
      (request: any) => {
        const result = nativeToolResults(request.messages).find(value => value.toolCallId === 'read-branch')
        assert.ok(result && !result.isError, JSON.stringify(result))
        assert.ok(JSON.stringify(result.content).includes(marker), 'the native read must deliver the actual file bytes')
        return f.mock.textResponse('The admitted branch read PLAN.md successfully.')
      },
    )
    branch.agent.followup(f.llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: task }] }))
    await branch.agent.whenIdle()
    assert.deepEqual(errors, [])
    assert.equal(observedOwner, true)
    const calls = branch.agent.session.snapshotEvents().filter((event: any) => event.seq >= ownStart && event.type === 'tool/call')
    assert.deepEqual(calls.map((event: any) => event.data.name), ['prepare_requested_work', 'kioku_read'])
  } finally {
    disposeErrors()
    await branch?.dispose()
    await f.close()
  }
}))
