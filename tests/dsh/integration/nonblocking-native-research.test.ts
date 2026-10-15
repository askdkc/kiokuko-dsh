/** Public plugin + actual DSH agent/tool dispatch + real owned shell/TCP.
 * The scripted model supplies exact source-bound interpretations; no model-quality claim. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { randomInt } from 'node:crypto'
import { join } from 'node:path'
import { openConnection } from '../../../src/db/connection.js'
import { nativeSkillFixture } from '../helpers/skill-native.js'
import { withIsolatedSkillHome } from '../helpers/skill-home.js'
import { interpretedPreparation, toolValue } from '../helpers/coding-script.js'
import { nativeToolResults } from '../helpers/native-mock.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const available = existsSync(join(packages, '@deepseek-ai/dsh-tools/lib/index.js'))
if (!available) throw new Error('Native research regressions require the pinned DSH fixture')
const options = { lisp: { enabled: false }, typedDecisions: { mode: 'off' }, answerReview: { mode: 'off' },
  memoryReuse: { mode: 'off' }, memoryReview: { mode: 'off' }, memoryEvolution: { mode: 'off' },
  memoryIndexReasoning: { mode: 'off' }, semanticCompaction: { mode: 'off' }, modelAutoMode: { mode: 'off' },
  toolExposure: { mode: 'full' } }
async function listen(server: Server): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = randomInt(10001, 65001)
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (error: Error) => { server.off('listening', ready); reject(error) }
        const ready = () => { server.off('error', fail); resolve() }
        server.once('error', fail); server.once('listening', ready); server.listen(port, '127.0.0.1')
      })
      return port
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error }
  }
  throw new Error('No free authorized high TCP port')
}
for (const relation of ['new', 'same_scope_continuation'] as const) {
  test(`public native research ${relation}: curl works without a formal Goal with a current native lease`, { timeout: 120_000 }, async () => withIsolatedSkillHome(async () => {
    let hits = 0
    const marker = 'HARMLESS_NATIVE_RESEARCH_RESPONSE'
    const server = createServer((_request, response) => { hits++; response.end(marker) })
    const port = await listen(server)
    const f = await nativeSkillFixture({ packages, extra: options })
    let db: ReturnType<typeof openConnection> | undefined
    let proved = false
    const command = `curl --fail --silent --show-error --max-time 3 http://127.0.0.1:${port}/inspection`
    const foreground = f.model.stream.bind(f.model)
    f.model.stream = async function* (request: any) {
      if (request.purpose === 'compaction') { yield* f.mock.textResponse('[]'); return }
      yield* foreground(request)
    }
    try {
      f.responses.push(
        interpretedPreparation(f.mock, 'research-prepare', relation, 'research', 'research'),
        (request: any) => {
          const result = toolValue(request, 'research-prepare')
          assert.equal(result.prepared, true); assert.equal(result.permissions, 'unchanged_native_policy')
          assert.equal(result.requestIntent.relation, relation)
          assert.equal(result.requestIntent.evidence.runId, undefined, 'there is no formal Goal to resume')
          db = openConnection(join(f.dir, 'kiokuko-dsh.sqlite3'))
          assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dsh_coding_workflows').get<{ n: number }>()!.n, 0)
          return f.mock.toolCallResponse('research-curl', 'kioku_exec', { command })
        },
        async (request: any) => {
          const result = toolValue(request, 'research-curl')
          assert.equal(result.exitCode, 0); assert.equal(result.output, marker)
          assert.equal(result.receipt.processStarted, true); assert.equal(result.receipt.processStopped, true)
          assert.ok(result.receipt.taskAuthority, 'ordinary command keeps native task lease')
          assert.equal(hits, 1)
          proved = true
          return f.mock.textResponse('The local response was observed.')
        },
      )
      await f.turn(`Continue inspecting this exact local endpoint with curl: http://127.0.0.1:${port}/inspection. Read the response only; do not edit any files. 通常実行で。`)
      assert.equal(proved, true, 'the actual native process must run')
      assert.equal(hits, 1)
    } finally {
      db?.close(); await f.close()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  }))
}

test('public native Bash dispatch needs no preparation/Goal/memory selection and survives optional memory-provider failure', { timeout: 120_000 }, async () => withIsolatedSkillHome(async () => {
  const { pathToFileURL } = await import('node:url')
  const { mock } = await import('node:test')
  const { DshAnswerContext } = await import('../../../src/dsh/answer-context.js')
  let optionalMemoryCalls = 0, hits = 0, proved = false
  const failedMemory = mock.method(DshAnswerContext.prototype, 'prepare', async () => { optionalMemoryCalls++; throw new Error('Optional memory database/provider is unavailable') })
  const server = createServer((_request, response) => { hits++; response.end('DIRECT_NATIVE_RESPONSE') })
  const port = await listen(server)
  const f = await nativeSkillFixture({ packages, extra: options })
  const fibers: any[] = []
  let db: ReturnType<typeof openConnection> | undefined
  try {
    for (const name of ['dsh-subprocess-local', 'dsh-bash-local', 'dsh-shell-env', 'dsh-tool-bash']) {
      const plugin = await import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)
      fibers.push(await f.ctx.plugin(plugin.default ?? plugin, name === 'dsh-bash-local' ? { cwd: f.dir }
        : name === 'dsh-shell-env' ? { dshHome: f.dir } : {}))
    }
    assert.ok(f.ctx.tools.get('bash', f.agent), 'actual native Bash must be installed')
    const command = `curl --fail --silent --show-error --max-time 3 http://127.0.0.1:${port}/direct`
    f.responses.push(f.mock.toolCallResponse('ordinary-curl', 'bash', { command, description: 'Read the requested local response' }),
      (request: any) => {
        const result = nativeToolResults(request.messages).find((value: any) => value.toolCallId === 'ordinary-curl')
        assert.ok(result && !result.isError, JSON.stringify(result))
        assert.match(JSON.stringify(result.content), /DIRECT_NATIVE_RESPONSE/)
        db = openConnection(join(f.dir, 'kiokuko-dsh.sqlite3'))
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_runs').get<{ n: number }>()!.n, 0, 'native Bash does not create an owned task')
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dsh_coding_workflows').get<{ n: number }>()!.n, 0)
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get<{ n: number }>()!.n, 0, 'no memory is saved while executing')
        assert.equal(optionalMemoryCalls, 0, 'optional memory startup is not on this execution path')
        assert.equal(hits, 1)
        proved = true
        return f.mock.textResponse('Local endpoint inspected.')
      })
    await f.turn(`Read http://127.0.0.1:${port}/direct with curl. No edits or installation.`)
    assert.equal(proved, true)
    assert.deepEqual(f.agent.session.snapshotEvents().filter((event: any) => event.type === 'tool/call').map((event: any) => event.data.name), ['bash'])
  } finally {
    db?.close(); for (const fiber of fibers.reverse()) await fiber.dispose()
    await f.close(); failedMemory.mock.restore()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}))

test('public native Bash remains preparation-free after a completed task in the same session', { timeout: 120_000 }, async () => withIsolatedSkillHome(async () => {
  const { pathToFileURL } = await import('node:url')
  const { TASK_WORKFLOW_SERVICE } = await import('../../../src/dsh/task-state-host.js')
  const f = await nativeSkillFixture({ packages, extra: options })
  const fibers: any[] = []
  const db = openConnection(join(f.dir, 'kiokuko-dsh.sqlite3'))
  let firstDone = false, secondDone = false, hits = 0
  const server = createServer((_request, response) => { hits++; response.end('AFTER_COMPLETED_HISTORY') })
  const port = await listen(server)
  const foreground = f.model.stream.bind(f.model)
  f.model.stream = async function* (request: any) {
    if (request.purpose === 'compaction') { yield* f.mock.textResponse('[]'); return }
    yield* foreground(request)
  }
  try {
    for (const name of ['dsh-subprocess-local', 'dsh-bash-local', 'dsh-shell-env', 'dsh-tool-bash']) {
      const plugin = await import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)
      fibers.push(await f.ctx.plugin(plugin.default ?? plugin, name === 'dsh-bash-local' ? { cwd: f.dir }
        : name === 'dsh-shell-env' ? { dshHome: f.dir } : {}))
    }
    f.responses.push(interpretedPreparation(f.mock, 'prior-prepare', 'new', 'research', 'research'),
      f.mock.toolCallResponse('prior-process', 'kioku_exec', { command: 'printf PRIOR_TASK_OBSERVED' }),
      async (request: any) => {
        const result = toolValue(request, 'prior-process')
        assert.equal(result.output, 'PRIOR_TASK_OBSERVED'); assert.equal(result.receipt.processStopped, true)
        const workflow = f.ctx.get(TASK_WORKFLOW_SERVICE, false)
        const completed = await workflow.operate(f.agent, { operation: 'complete', evidence: [result.receipt.evidenceRef], reason: 'The exact requested response was observed' }, new AbortController().signal)
        assert.equal(completed.state, 'Done'); firstDone = true
        return f.mock.textResponse('The first inspection is complete.')
      })
    await f.turn('Inspect the local printf response without changing any files. 通常実行で。')
    assert.equal(firstDone, true)
    // Public task completion is canonical Done; the separate host execution
    // outcome may be settled later. Use the actual ledger close service here
    // to model the fully terminal history retained by ordinary old sessions.
    const { LedgerStore } = await import('../../../src/ledger/store.js')
    const previous = db.prepare('SELECT run_id,status,task_state FROM ledger_runs LIMIT 1').get<{ run_id: string; status: string; task_state: string }>()!
    assert.equal(previous.task_state, 'Done')
    new LedgerStore(db).updateRunStatus(previous.run_id, 'completed')
    assert.equal(db.prepare('SELECT status FROM ledger_runs WHERE run_id=?').get<{ status: string }>(previous.run_id)!.status, 'completed')
    const boundary = f.agent.session.seq
    f.responses.push(f.mock.toolCallResponse('post-history-curl', 'bash', { command: `curl --fail --silent --show-error --max-time 3 http://127.0.0.1:${port}/after-completion`, description: 'Inspect the next requested local response' }),
      (request: any) => {
        const result = nativeToolResults(request.messages).find((value: any) => value.toolCallId === 'post-history-curl')
        assert.ok(result && !result.isError, JSON.stringify(result)); assert.match(JSON.stringify(result.content), /AFTER_COMPLETED_HISTORY/)
        assert.equal(hits, 1); secondDone = true
        return f.mock.textResponse('The second inspection is complete.')
      })
    await f.turn(`Read http://127.0.0.1:${port}/after-completion with curl. Do not create a new task or change any files.`)
    assert.equal(secondDone, true)
    assert.deepEqual(f.agent.session.snapshotEvents().filter((event: any) => event.seq >= boundary && event.type === 'tool/call').map((event: any) => event.data.name), ['bash'])
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_runs').get<{ n: number }>()!.n, 1, 'completed history is retained; no new task is created')
  } finally {
    db.close(); for (const fiber of fibers.reverse()) await fiber.dispose(); await f.close()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}))
