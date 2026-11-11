import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { initializeDatabase } from '../../../src/dsh/database.js'
import { openConnection } from '../../../src/db/connection.js'
import { KiokukoError } from '../../../src/errors.js'
import { resolveProjectWorkspaceReadOnly } from '../../../src/memory/workspaces.js'
import { registerRepositoryAndLocation, RepositoryBindingConflict, inspectRepositoryBindingReadOnly } from '../../../src/repository/binding.js'
import { createRepositoryIdentity } from '../../../src/repository/identity.js'

async function fixture(t: test.TestContext) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'binding-conflicts-')))
  const databasePath = join(root, 'memory.sqlite3')
  await initializeDatabase({ databasePath })
  const db = openConnection(databasePath)
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }) })
  const current = join(root, 'current'), other = join(root, 'other')
  await mkdir(current); await mkdir(other)
  const register = (repositoryId: string, workspace: string, canonicalRoot = other, agentTemplateVersion = 1) =>
    registerRepositoryAndLocation(db, { repositoryId, workspace, canonicalRoot, displayName: 'fixture',
      remoteFingerprint: null, bindingSchemaVersion: 1, agentTemplateVersion, now: '2026-01-01T00:00:00.000Z' })
  const snapshot = () => ({ repositories: db.prepare('SELECT * FROM repositories ORDER BY repository_id').all(),
    locations: db.prepare('SELECT * FROM repository_locations ORDER BY canonical_root').all() })
  return { root, current, other, db, register, snapshot }
}
test('unregistered exploration remains read-only while automatic binding requires the registered root', async t => {
  const f = await fixture(t)
  const candidate = {repositoryRoot:f.current,repositoryId:'repo_owner',workspace:'project:owner'}
  f.register(candidate.repositoryId,candidate.workspace,f.other)
  const before = f.snapshot()
  assert.equal(inspectRepositoryBindingReadOnly(f.db,candidate),true)
  assert.equal(inspectRepositoryBindingReadOnly(f.db,candidate,{requireRegisteredRoot:true}),false)
  assert.deepEqual(f.snapshot(),before)
  await writeFile(join(f.current,'.kiokuko.json'),JSON.stringify({schemaVersion:1,...candidate,repositoryRoot:undefined,agentFile:'AGENTS.md',templateVersion:1}))
  const explored = await resolveProjectWorkspaceReadOnly(f.db,f.current)
  assert.equal(explored?.workspace,candidate.workspace)
  assert.deepEqual(f.snapshot(),before)
  f.register(candidate.repositoryId,candidate.workspace,f.current)
  const registered = f.snapshot()
  assert.equal(inspectRepositoryBindingReadOnly(f.db,candidate,{requireRegisteredRoot:true}),true)
  assert.deepEqual(f.snapshot(),registered)
})
test('malformed configuration is not downgraded to an optional binding conflict', async t => {
  const f = await fixture(t)
  await writeFile(join(f.current,'.kiokuko.json'),'{broken')
  const before = f.snapshot()
  await assert.rejects(resolveProjectWorkspaceReadOnly(f.db,f.current),error => !(error instanceof RepositoryBindingConflict))
  assert.deepEqual(f.snapshot(),before)
})
const collisions = [
  { kind: 'root', repositoryId: 'repo_candidate', workspace: 'project:candidate', sameRoot: true },
  { kind: 'repository-id', repositoryId: 'repo_owner', workspace: 'project:candidate', sameRoot: false },
  { kind: 'workspace', repositoryId: 'repo_candidate', workspace: 'project:owner', sameRoot: false },
] as const
for (const collision of collisions) {
  test(`registration classifies ${collision.kind} identity collision as repository memory conflict`, async t => {
    const f = await fixture(t)
    f.register('repo_owner', 'project:owner', collision.sameRoot ? f.current : f.other)
    const before = f.snapshot()
    assert.throws(() => f.register(collision.repositoryId, collision.workspace, f.current), error =>
      error instanceof RepositoryBindingConflict && error.code === 'CONFLICT' && error.details.scope === 'repository_memory')
    assert.deepEqual(f.snapshot(), before)
  })
  test(`read-only resolution withholds ${collision.kind} collision without writes`, async t => {
    const f = await fixture(t)
    f.register('repo_owner', 'project:owner', collision.sameRoot ? f.current : f.other)
    await writeFile(join(f.current, '.kiokuko.json'), JSON.stringify({ schemaVersion: 1,
      repositoryId: collision.repositoryId, workspace: collision.workspace, agentFile: 'AGENTS.md', templateVersion: 1 }))
    const before = f.snapshot()
    assert.equal(await resolveProjectWorkspaceReadOnly(f.db, f.current), undefined)
    await assert.rejects(resolveProjectWorkspaceReadOnly(f.db, f.current, { rejectBindingConflict: true }), RepositoryBindingConflict)
    assert.deepEqual(f.snapshot(), before)
  })
}
test('read-only local-path candidate rejects a cross-root repository-ID collision', async t => {
  const f = await fixture(t)
  const repositoryId = `repo_local_${createHash('sha256').update(f.current, 'utf8').digest('hex').slice(0, 12)}`
  const identity = createRepositoryIdentity({ repositoryRoot: f.current, repositoryId })
  f.register(identity.repositoryId, 'project:foreign', f.other)
  const before = f.snapshot()
  assert.equal(await resolveProjectWorkspaceReadOnly(f.db, f.current, { allowDirectory: true }), undefined)
  await assert.rejects(resolveProjectWorkspaceReadOnly(f.db, f.current, { allowDirectory: true, rejectBindingConflict: true }), RepositoryBindingConflict)
  assert.deepEqual(f.snapshot(), before)
})
test('newer metadata and stale rebind remain generic conflicts', async t => {
  const f = await fixture(t)
  f.register('repo_owner', 'project:owner', f.current, 2)
  const before = f.snapshot()
  const genericConflict = (error: unknown) => error instanceof KiokukoError && error.code === 'CONFLICT' && !(error instanceof RepositoryBindingConflict)
  assert.throws(() => f.register('repo_owner', 'project:owner', f.current, 1), genericConflict)
  assert.throws(() => registerRepositoryAndLocation(f.db, {
    repositoryId: 'repo_next', workspace: 'project:next', canonicalRoot: f.current, displayName: 'next',
    remoteFingerprint: null, bindingSchemaVersion: 1, agentTemplateVersion: 2,
    rebindFrom: { repositoryId: 'repo_stale', workspace: 'project:stale' },
  }), genericConflict)
  assert.deepEqual(f.snapshot(), before)
})
