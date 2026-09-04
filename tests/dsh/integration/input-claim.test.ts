import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { withImmediateTransaction } from '../../../src/db/transaction.js'
import {
  backupInputClaimInTransaction,
  markClaimProgressInTransaction,
  settleInputClaimInTransaction,
  takeRecoverableInputClaimInTransaction,
} from '../../../src/dsh/input-claim.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-input-claim-'))
  const database = openConnection(join(root, 'data.sqlite3'))
  migrateDatabase(database, join(process.cwd(), 'migrations'))
  return { database, cleanup: async () => { database.close(); await rm(root, { recursive: true, force: true }) } }
}

const exactMessages = [
  {
    id: 'human-message', role: 'user',
    content: [
      { type: 'text', text: '/review\r\nABC\n\nEFG' },
      { type: 'file', path: '@src/process.ts' },
      { type: 'session', id: '@session:previous' },
    ],
    source: { kind: 'user' },
  },
]

test('claim backup preserves multiline, slash, file, session, order, and content blocks exactly', async () => {
  const f = await fixture()
  try {
    const claim = withImmediateTransaction(f.database, () => backupInputClaimInTransaction(f.database, {
      dshSessionId: 'input-session', nativeTurn: 1, messages: exactMessages,
    }))
    assert.deepEqual(claim.messages, exactMessages)
    const replay = withImmediateTransaction(f.database, () => backupInputClaimInTransaction(f.database, {
      dshSessionId: 'input-session', nativeTurn: 1, messages: exactMessages,
    }))
    assert.equal(replay.claimId, claim.claimId)
  } finally {
    await f.cleanup()
  }
})

test('only a pre-provider error can consume one recovery', async () => {
  const f = await fixture()
  try {
    withImmediateTransaction(f.database, () => backupInputClaimInTransaction(f.database, {
      dshSessionId: 'recoverable-session', nativeTurn: 1, messages: exactMessages,
    }))
    const settled = withImmediateTransaction(f.database, () => settleInputClaimInTransaction(f.database, {
      dshSessionId: 'recoverable-session', nativeTurn: 1, turnEndedWithError: true,
    }))
    assert.equal(settled?.status, 'recoverable')
    const recovered = withImmediateTransaction(f.database, () => takeRecoverableInputClaimInTransaction(
      f.database, 'recoverable-session', 1,
    ))
    assert.deepEqual(recovered?.messages, exactMessages)
    assert.equal(recovered?.recoveryCount, 1)
    assert.equal(withImmediateTransaction(f.database, () => takeRecoverableInputClaimInTransaction(
      f.database, 'recoverable-session', 1,
    )), undefined)

    withImmediateTransaction(f.database, () => {
      backupInputClaimInTransaction(f.database, {
        dshSessionId: 'unsafe-session', nativeTurn: 2, messages: exactMessages,
      })
      markClaimProgressInTransaction(f.database, {
        dshSessionId: 'unsafe-session', nativeTurn: 2, providerStarted: true,
      })
    })
    const unsafe = withImmediateTransaction(f.database, () => settleInputClaimInTransaction(f.database, {
      dshSessionId: 'unsafe-session', nativeTurn: 2, turnEndedWithError: true,
    }))
    assert.equal(unsafe?.status, 'unsafe')
    assert.equal(withImmediateTransaction(f.database, () => takeRecoverableInputClaimInTransaction(
      f.database, 'unsafe-session', 2,
    )), undefined)
  } finally {
    await f.cleanup()
  }
})
