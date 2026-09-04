import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { submitEnnoAdvice, submitOdunoIdeal } from '../../../src/enno-oduno/service.js'
import { readEnnoSnapshot } from '../../../src/enno-oduno/store.js'
import { advisoryContextForSnapshot, advisoryInputDigest, advisorySlotDefinitions } from '../../../src/enno-oduno/advisory.js'

// The newline from the reported session is data, not a model instruction.
const reportedRequest = '@README.org が冗長で長いんだけど。\nhttps://github.com/askdkc/crit-magit から use-package vc でインストール可能にして、デフォルトでmagit内にショートカット使えるようにする方法だけ記載すればいいよ。LICENSEはEmacsなのでGNUな'

for (const phase of ['ideal', 'planning'] as const) {
  test(`${phase} advice accepts the exact multiline intake projection and replays after reopening`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiokuko-multiline-advice-'))
    await mkdir(join(root, 'src'))
    const databasePath = join(root, 'data.sqlite3')
    let database = openConnection(databasePath)
    try {
      migrateDatabase(database, join(process.cwd(), 'migrations'))
      const prepared = await prepareAgentTask(database, {
        requestId: `multiline-${phase}`, cwd: root, task: reportedRequest,
        profileHints: { taskType: 'build', target: 'src', expected: reportedRequest, constraints: '文書のみ変更する。\n既存のコードは保持する。' },
        capabilities: [], dshSessionId: `multiline-${phase}`, skillDiscoveryMode: 'off',
      })
      const identity = { runId: prepared.run.runId, workspace: prepared.project.workspace, orchestrationId: prepared.intake.sessionId }
      if (phase === 'planning') submitOdunoIdeal(database, {
        ...identity, expectedRevision: 1, idempotencyKey: 'ideal',
        ideal: { objective: 'READMEを短くする。', principles: ['文書に限定する。'], skillContributions: [], successSignals: ['導入手順が明確。'] },
      })
      const snapshot = readEnnoSnapshot(database, identity)
      const context = advisoryContextForSnapshot(snapshot, phase)
      if (context.phase === 'planning') assert.equal(context.acceptanceCriteria[0], reportedRequest)
      if (context.phase === 'ideal') assert.equal(context.expectedOutcome, reportedRequest)
      const input = {
        ...identity, expectedRevision: snapshot.revision, mutationRevision: snapshot.mutationRevision,
        idempotencyKey: `advice-${phase}`, phase, allowlistedContext: context,
        contributions: advisorySlotDefinitions(phase).map(slot => ({
          slotId: slot.slotId, outcome: 'unavailable', reasonCode: 'host_read_only_unavailable',
        })),
      }
      const response = submitEnnoAdvice(database, input)
      assert.equal(response.ennoOduno.advisoryPhaseState.state, 'aggregated')
      assert.equal(response.ennoOduno.advisoryPhaseState.inputDigest, advisoryInputDigest({
        phase, contractRevision: snapshot.revision, mutationRevision: snapshot.mutationRevision, allowlistedContext: context,
      }))
      database.close()
      database = openConnection(databasePath)
      assert.deepEqual(submitEnnoAdvice(database, input), response)
      assert.deepEqual(advisoryContextForSnapshot(readEnnoSnapshot(database, identity), phase), context)
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM enno_advisory_rounds').get<{ count: number }>()?.count, 1)
    } finally { database.close(); await rm(root, { recursive: true, force: true }) }
  })
}
