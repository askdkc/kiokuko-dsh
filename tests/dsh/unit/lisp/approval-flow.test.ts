import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { LispProposalBatch } from '../../../../src/dsh/lisp/proposal-batch.js'
import { createLispCiAdapter } from '../../../../src/dsh/lisp/ci.js'
import { createLispPackageAdapter } from '../../../../src/dsh/lisp/packages.js'
import type { ApprovalQuestions } from '../../../../src/dsh/lisp/approval.js'

test('one profile policy covers successive file, verifier and registry effects with no questions', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'auto-flow-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const owner = { agentId: 'a', sessionId: 's', root }, signal = new AbortController().signal
  let mode: 'ask' | 'auto' = 'auto', asks = 0, commands = 0, fetches = 0
  const questions: ApprovalQuestions = { approvalPolicy: { mode: () => mode, writable: () => true, validate: () => {}, set: async value => { mode = value } },
    ask: async request => { asks++; return { answers: [{ id: request.questions[0].id, selected: [request.questions[0].options![0]!.label] }] } } }
  const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:'))
  t.after(() => db.close())
  db.exec(readFileSync(new URL('../../../../migrations/019_dsh_lisp.sql', import.meta.url), 'utf8'))
  const store = new LispStore(async fn => fn(db)); await store.enable(owner)
  await writeFile(join(root, 'a.txt'), 'before')
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc', 'test:packages': 'node test.js' } }))
  const batch = new LispProposalBatch({ store, backupRoot: join(root, 'backups'), protectedRoots: () => [], stopped: () => false, questions })
  const changes = await batch.apply(owner, 'eval', 'generation', [{ operation: 'write', path: 'a.txt', content: 'after' }], signal)
  assert.equal(changes[0]!.state, 'APPLIED'); assert.equal(changes[0]!.approval, 'profile')
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'after')
  const ci = createLispCiAdapter(questions, async () => { commands++; return { code: 0, stdout: 'ok', stderr: '' } })
  for (const request of [{ kind: 'verify', target: 'typecheck' }, { kind: 'verify', target: 'test', script: 'test:packages' }] as const) {
    assert.equal((await ci(owner, request, signal) as any).approval, 'profile')
  }
  const packages = createLispPackageAdapter(questions, async () => { fetches++; return Response.json({ name: 'test', version: '1.0.0', dist: { integrity: 'sha512-test', tarball: 'https://registry.npmjs.org/test/-/test-1.0.0.tgz' } }) })
  assert.equal(((await packages(owner, {kind:'metadata',name:'test'}, signal)).value as {state:string}).state, 'SUCCEEDED')
  assert.equal(asks, 0); assert.equal(commands, 2); assert.equal(fetches, 1)
  // Reproduce a race after capture without a dialog or the question service.
  questions.approvalPolicy!.validate = () => writeFileSync(join(root, 'package.json'), JSON.stringify({scripts:{typecheck:'changed'}}))
  assert.equal((await ci(owner, {kind:'verify',target:'typecheck'}, signal) as any).state, 'NOT_APPLIED')
  assert.equal(commands,2)
  questions.approvalPolicy!.validate = () => writeFileSync(join(root,'a.txt'),'concurrent edit')
  const stale = await batch.apply(owner,'stale','generation',[{operation:'write',path:'a.txt',content:'must not overwrite'}],signal)
  assert.notEqual(stale[0]!.state,'APPLIED'); assert.equal(await readFile(join(root,'a.txt'),'utf8'),'concurrent edit')
  questions.approvalPolicy!.validate = () => {}
  await writeFile(join(root,'unusable-backup'),'not a directory')
  const broken = new LispProposalBatch({store,backupRoot:join(root,'unusable-backup'),protectedRoots:()=>[],stopped:()=>false,questions})
  const failed = await broken.apply(owner,'backup-failure','generation',[{operation:'write',path:'a.txt',content:'must not overwrite'}],signal)
  assert.notEqual(failed[0]!.state,'APPLIED'); assert.equal(await readFile(join(root,'a.txt'),'utf8'),'concurrent edit')
  assert.equal(asks,0)
  mode = 'ask'; await ci(owner, {kind:'verify',target:'typecheck'}, signal)
  assert.equal(asks, 1); assert.equal(commands, 2)
})
