import assert from 'node:assert/strict'
import test from 'node:test'
import { decideAutoGlobalization } from '../../../src/memory/auto-globalization.js'

const proof = (runId: string, rootRunId = runId, repositoryId = 'repo-a') => ({
  run_id:runId, root_run_id:rootRunId, repository_id:repositoryId, receipt_digest:`proof-${runId}`,
})

test('automatic Global policy counts independent roots and repository identities', () => {
  const decide = (receipts: unknown[], hasApplicability = false, matches = receipts.map(() => true)) =>
    decideAutoGlobalization({receipts:receipts as any, adverse:false, portable:true,
      hasApplicability, applicabilityMatches:matches})
  const first = [proof('a'), proof('b')]
  assert.equal(decide(first).kind, 'insufficient_evidence')
  assert.equal(decide([...first, proof('child','a')]).kind, 'insufficient_evidence')
  assert.equal(decide([...first, proof('c')]).reason, 'portability_not_established')
  assert.equal(decide([...first, proof('c')], true).kind, 'eligible')
  assert.equal(decide([...first, proof('c')], true, [true,false,true]).kind, 'insufficient_evidence')
  assert.equal(decide([...first, proof('c','c','repo-b')]).kind, 'eligible')
  const three = decide([...first, proof('c','c','repo-b')])
  assert.equal(decide([...first, proof('c','c','repo-b'), proof('d')]).evidenceDigest, three.evidenceDigest)
  assert.equal(decideAutoGlobalization({receipts:[...first, proof('c','c','repo-b')] as any,
    adverse:true, portable:true, hasApplicability:false, applicabilityMatches:[true,true,true]}).kind, 'blocked')
})
