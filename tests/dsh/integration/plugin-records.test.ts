import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { saveEvolutionObservation, readEvolutionObservation, saveSessionNotice } from '../../../src/dsh/plugin-records.js'
import { executionObservation } from '../../../src/dsh/evolution-observation.js'
import { dshNoticeResponse } from '../../../src/dsh/session-notice-surface.js'
import type { DeepPlanningController } from '../../../src/deep-thinker/controller.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-plugin-records-'))
  const path = join(root, 'db.sqlite3'), db = openConnection(path)
  migrateDatabase(db, join(process.cwd(), 'migrations'))
  const prepared = await prepareAgentTask(db, { requestId: 'plugin-records', cwd: root, task: 'inspect source', dshSessionId: 'session',
    profileHints: { taskType: 'debug', target: 'source', expected: 'verified', constraints: null }, skillDiscoveryMode: 'off',
    capabilities: [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'kiokuko-single-purpose-functions' }] })
  const binding = { runId: prepared.run.runId, workspace: prepared.project.workspace, sessionId: 'session' }
  return { root, path, db, binding, close: async () => { db.close(); await rm(root, { recursive: true, force: true }) } }
}

test('observations persist independently of native history and reject cross-run or conflicting proof', async () => {
  const f = await fixture()
  try {
    const proof = executionObservation(f.binding, 'call', 21, { value: { exitCode: 0 }, content: [{ type: 'text', text: 'output' }], isError: false })!
    saveEvolutionObservation(f.db, proof)
    saveEvolutionObservation(f.db, structuredClone(proof))
    const reader = openConnection(f.path)
    try { assert.deepEqual(readEvolutionObservation(reader, f.binding, 21), proof) } finally { reader.close() }
    assert.equal(readEvolutionObservation(f.db, { ...f.binding, workspace: 'other' }, 21), undefined)
    assert.equal(readEvolutionObservation(f.db, { ...f.binding, sessionId: 'other' }, 21), undefined)
    assert.equal(readEvolutionObservation(f.db, { ...f.binding, runId: 'other' }, 21), undefined)
    assert.throws(() => saveEvolutionObservation(f.db, { ...proof, exitCode: 1, failed: true }), /Conflicting/)
    assert.throws(() => saveEvolutionObservation(f.db, { ...proof, callSeq: 22, sessionId: 'other' }), /exact DSH run/)
    assert.deepEqual(readEvolutionObservation(f.db, f.binding, 21), proof)
  } finally { await f.close() }
})

test('normal-session notices survive restart, bind workspace and session, and acknowledge atomically after display', async () => {
  const f = await fixture()
  try {
    const base = { runId: f.binding.runId, sessionId: 'session', rootPath: f.root, anchorSeq: 21 }
    saveSessionNotice(f.db, { ...base, id: 'report', kind: 'report', text: 'Verified result' })
    saveSessionNotice(f.db, { ...base, id: 'status-old', kind: 'status', text: 'Earlier pause' })
    saveSessionNotice(f.db, { ...base, id: 'status', kind: 'status', text: 'Waiting for input' })
    assert.throws(() => saveSessionNotice(f.db, { ...base, id: 'report', kind: 'report', text: 'Different' }), /Conflicting/)
    let cwd = f.root
    const reader = openConnection(f.path)
    const host = { store: { database: async (fn: any) => fn(reader) }, options: { sessionQuery: {
      readSession: async (id: string) => ({ session: { id, cwd } }),
    } } } as unknown as DeepPlanningController
    const request = (suffix = '', method = 'GET', origin = 'http://localhost:8080') => new Request(`http://dsh.internal/api/kiokuko.notices?sessionId=session${suffix}`,
      { method, headers: { host: 'localhost:8080', origin } })
    try {
      const response = await dshNoticeResponse(host, request())
      assert.equal(response.status, 200)
      const { items } = await response.json() as any
      assert.deepEqual(items.map((item: any) => [item.id, item.text, item.delivered]), [['report', 'Verified result', false], ['status', 'Waiting for input', false]])
      const cached = request(); cached.headers.set('if-none-match', response.headers.get('etag')!)
      assert.equal((await dshNoticeResponse(host, cached)).status, 304)
      cwd = tmpdir()
      assert.equal((await dshNoticeResponse(host, request())).status, 409)
      cwd = f.root
      assert.equal((await dshNoticeResponse(host, request('&id=report', 'POST', 'https://evil.invalid'))).status, 403)
      assert.equal((await dshNoticeResponse(host, request('&id=report&id=unknown', 'POST'))).status, 503)
      assert.equal(reader.prepare('SELECT sum(delivered) AS n FROM dsh_session_notices').get()?.n, 0)
      assert.equal((await dshNoticeResponse(host, request('&id=report&id=status', 'POST'))).status, 200)
      assert.equal((await dshNoticeResponse(host, request('&id=report&id=status', 'POST'))).status, 200)
      assert.equal(reader.prepare('SELECT sum(delivered) AS n FROM dsh_session_notices').get()?.n, 3)
      assert.equal((await dshNoticeResponse(host, cached)).status, 200)
      const unrelated = new Request('http://dsh.internal/api/kiokuko.notices?sessionId=unrelated')
      assert.deepEqual(await (await dshNoticeResponse(host, unrelated)).json(), { items: [] })
    } finally { reader.close() }
  } finally { await f.close() }
})
