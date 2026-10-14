import assert from 'node:assert/strict'
import test from 'node:test'
import { openConnection } from '../../../src/db/connection.js'
import { withImmediateTransaction } from '../../../src/db/transaction.js'

test('nested managed writes use savepoints without discarding independent outer changes', () => {
  const db=openConnection(':memory:')
  try {
    db.exec('CREATE TABLE value(id INTEGER PRIMARY KEY)')
    withImmediateTransaction(db,()=>{
      db.exec('INSERT INTO value VALUES(1)')
      assert.throws(()=>withImmediateTransaction(db,()=>{db.exec('INSERT INTO value VALUES(2)');throw new Error('inner rejected')}),/inner rejected/)
      withImmediateTransaction(db,()=>db.exec('INSERT INTO value VALUES(3)'))
    })
    assert.deepEqual(db.prepare('SELECT id FROM value ORDER BY id').all(),[{id:1},{id:3}].map(value=>Object.assign(Object.create(null),value)))
    assert.throws(()=>withImmediateTransaction(db,()=>{
      withImmediateTransaction(db,()=>db.exec('INSERT INTO value VALUES(4)'));throw new Error('outer rejected')
    }),/outer rejected/)
    assert.equal(db.prepare('SELECT count(*) AS count FROM value').get<any>()!.count,2)
    withImmediateTransaction(db,()=>db.exec('INSERT INTO value VALUES(5)'))
    assert.equal(db.prepare('SELECT count(*) AS count FROM value').get<any>()!.count,3)
  } finally {db.close()}
})

test('raw external transactions remain caller-owned and are not guessed from SQLite errors',()=>{
  const db=openConnection(':memory:')
  try {
    db.exec('CREATE TABLE value(id INTEGER PRIMARY KEY)');db.exec('BEGIN IMMEDIATE');db.exec('INSERT INTO value VALUES(1)')
    assert.throws(()=>withImmediateTransaction(db,()=>db.exec('INSERT INTO value VALUES(2)')),/within a transaction/)
    db.exec('ROLLBACK')
    withImmediateTransaction(db,()=>db.exec('INSERT INTO value VALUES(3)'))
    assert.equal(db.prepare('SELECT id FROM value').get<any>()!.id,3)
  } finally {db.close()}
})
