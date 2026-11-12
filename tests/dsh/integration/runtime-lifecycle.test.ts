import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { registerRepositoryAndLocation } from '../../../src/repository/binding.js'
import { mountDshRuntime } from '../../../src/dsh/index.js'
import { DshRuntime } from '../../../src/dsh/runtime.js'

async function makeRegisteredDatabase(): Promise<{
  root: string
  databasePath: string
  migrationsDirectory: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-runtime-root-'))
  await mkdir(join(root, 'src'))
  const databasePath = join(root, 'data.sqlite3')
  const database = openConnection(databasePath)
  try {
    const migrationsDirectory = join(process.cwd(), 'migrations')
    migrateDatabase(database, migrationsDirectory)
    registerRepositoryAndLocation(database, {
      repositoryId: 'repo-dsh-runtime',
      workspace: 'workspace-dsh-runtime',
      displayName: 'dsh runtime test',
      canonicalRoot: realpathSync(root),
      remoteFingerprint: null,
      bindingSchemaVersion: 1,
      agentTemplateVersion: 1,
    })
    return { root, databasePath, migrationsDirectory }
  } finally {
    database.close()
  }
}

test('runtime supports two agent turns and drains queued writes before closing the database', async () => {
  const fixture = await makeRegisteredDatabase()
  const events: string[] = []
  let releaseWrite!: () => void
  const writeReady = new Promise<void>((resolve) => { releaseWrite = resolve })
  const runtime = new DshRuntime({
    repositoryRoot: fixture.root,
    databasePath: fixture.databasePath,
    migrationsDirectory: fixture.migrationsDirectory,
    embeddingConfig: {
      mode: 'off',
      provider: 'openai-compatible',
      allowRemote: false,
      vectorBackend: 'auto',
      timeoutMs: 1000,
      batchSize: 1,
    },
  })
  try {
    const first = await runtime.openAgent({ dshSessionId: 'session-a', turn: 1 })
    const second = await runtime.openAgent({ dshSessionId: 'session-b', turn: 1 })
    assert.equal(first.workspace, 'workspace-dsh-runtime')
    assert.equal(second.repositoryId, 'repo-dsh-runtime')
    assert.equal(runtime.activeAgentCount, 2)
    const queued = runtime.enqueueWrite(async () => {
      events.push('write-start')
      await writeReady
      events.push('write-end')
    })
    const closing = runtime.close().then(() => events.push('closed'))
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(events, ['write-start'])
    releaseWrite()
    await queued
    await closing
    assert.deepEqual(events, ['write-start', 'write-end', 'closed'])
    assert.equal(runtime.activeAgentCount, 0)
    await assert.rejects(runtime.start(), /runtime is closed/u)
  } finally {
    await runtime.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('runtime rejects an unregistered repository and cleans up initialization failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-unregistered-'))
  const databasePath = join(root, 'data.sqlite3')
  const database = openConnection(databasePath)
  try {
    migrateDatabase(database, join(process.cwd(), 'migrations'))
  } finally {
    database.close()
  }
  const runtime = new DshRuntime({
    repositoryRoot: root,
    databasePath,
    migrationsDirectory: join(process.cwd(), 'migrations'),
    embeddingConfig: {
      mode: 'off',
      provider: 'openai-compatible',
      allowRemote: false,
      vectorBackend: 'auto',
      timeoutMs: 1000,
      batchSize: 1,
    },
  })
  await assert.rejects(runtime.start(), /not registered/u)
  await runtime.close()
  await assert.rejects(runtime.withDatabase(() => undefined), /runtime is closed/u)
  await rm(root, { recursive: true, force: true })

  const failed = new DshRuntime({
    repositoryRoot: process.cwd(),
    initializeDatabase: async () => { throw new Error('database unavailable') },
  })
  await assert.rejects(failed.start(), /database unavailable/u)
  await failed.close()
})

test('runtime auto-registers an ordinary directory without writing repository metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-directory-root-'))
  const databasePath = join(root, 'data.sqlite3')
  const runtime = new DshRuntime({
    repositoryRoot: root,
    databasePath,
    migrationsDirectory: join(process.cwd(), 'migrations'),
    embeddingConfig: {
      mode: 'off',
      provider: 'openai-compatible',
      allowRemote: false,
      vectorBackend: 'auto',
      timeoutMs: 1000,
      batchSize: 1,
    },
    autoRegisterRepository: true,
  })
  try {
    await runtime.start()
    const agent = await runtime.openAgent({ dshSessionId: 'ordinary-directory', turn: 1 })
    assert.match(agent.repositoryId, /^repo_local_[0-9a-f]{12}$/u)
    assert.equal(agent.workspace.startsWith('project:'), true)
    await assert.rejects(access(join(root, '.kiokuko.json')))
  } finally {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('runtime HMR-style dispose is idempotent and does not retain a live handle', async () => {
  const fixture = await makeRegisteredDatabase()
  const runtime = new DshRuntime({
    repositoryRoot: fixture.root,
    databasePath: fixture.databasePath,
    migrationsDirectory: fixture.migrationsDirectory,
    embeddingConfig: {
      mode: 'off',
      provider: 'openai-compatible',
      allowRemote: false,
      vectorBackend: 'auto',
      timeoutMs: 1000,
      batchSize: 1,
    },
  })
  await runtime.start()
  const context = new Context()
  const fiber = context.plugin({
    apply(pluginContext: Context) {
      mountDshRuntime(pluginContext, runtime)
    },
  })
  await fiber
  await fiber.dispose()
  await Promise.all([runtime.close(), runtime.close()])
  await rm(fixture.root, { recursive: true, force: true })
  assert.equal(runtime.activeAgentCount, 0)
  await assert.rejects(runtime.start(), /runtime is closed/u)
})

test('core close cancels unstarted database callbacks and rejects new work', async () => {
  const { DshCoreRuntime } = await import('../../../src/dsh/core-runtime.js')
  const fixture = await makeRegisteredDatabase()
  let release!: () => void, writes = 0
  const held = new Promise<void>(resolve => { release = resolve })
  const runtime = new DshCoreRuntime({repositoryRoot:fixture.root,databasePath:fixture.databasePath,
    initializeDatabase:()=>held})
  const work = runtime.withDatabase(() => { writes++ })
  const rejected = assert.rejects(work)
  const closing = runtime.close()
  await rejected
  await assert.rejects(runtime.withDatabase(() => { writes++ }))
  release()
  try { await closing; assert.equal(writes,0) }
  finally { release(); await runtime.close(); await rm(fixture.root,{recursive:true,force:true}) }
})

test('core close waits for actual executing transactions before closing the shared database', async () => {
  const { DshCoreRuntime } = await import('../../../src/dsh/core-runtime.js')
  const fixture = await makeRegisteredDatabase()
  const runtime = new DshCoreRuntime({repositoryRoot:fixture.root,databasePath:fixture.databasePath})
  let release!: () => void, started!: () => void, closed = false
  const held = new Promise<void>(resolve=>{release=resolve}), entered=new Promise<void>(resolve=>{started=resolve})
  try {
    const work=runtime.withDatabase(async db=>{started();await held;db.exec('CREATE TABLE close_order_test(value TEXT)');return db.prepare("SELECT 1 AS n").get()!.n})
    await entered
    const closing=runtime.close().then(()=>{closed=true})
    await new Promise(resolve=>setImmediate(resolve))
    assert.equal(closed,false)
    release();assert.equal(await work,1);await closing
    const check=openConnection(fixture.databasePath)
    try {assert.ok(check.prepare("SELECT name FROM sqlite_master WHERE name='close_order_test'").get())}finally{check.close()}
  } finally {release();await runtime.close();await rm(fixture.root,{recursive:true,force:true})}
})

test('close finishes while initialization is held and late initialization cannot open or publish a DB', async () => {
  const { DshCoreRuntime } = await import('../../../src/dsh/core-runtime.js')
  const { auxiliaryDatabase, auxiliaryDatabasePending } = await import('../../../src/dsh/auxiliary-database.js')
  const fixture = await makeRegisteredDatabase()
  let release!: () => void, opens = 0, writes = 0
  const held = new Promise<void>(resolve=>{release=resolve})
  const runtime = new DshCoreRuntime({repositoryRoot:fixture.root,databasePath:fixture.databasePath,
    initializeDatabase:()=>held,openDatabase:()=>{opens++;throw new Error('late open')}})
  const attempts=Promise.allSettled(Array.from({length:1000},()=>auxiliaryDatabase(runtime,()=>{writes++},()=>true)))
  const startup=assert.rejects(runtime.start())
  let closed=false
  const closing=runtime.close().then(()=>{closed=true})
  try {
    await attempts
    await new Promise(resolve=>setTimeout(resolve,80))
    assert.equal(closed,true,'close must not await the held initializer')
    await startup
    assert.equal(auxiliaryDatabasePending(runtime),0)
    await assert.rejects(runtime.withDatabase(()=>{writes++}))
  } finally {release();await closing;await startup;await new Promise(resolve=>setImmediate(resolve));await rm(fixture.root,{recursive:true,force:true})}
  assert.equal(opens,0);assert.equal(writes,0)
})

for (const configured of [false, true]) {
  test(`close detaches a held DB opener and closes its late connection without use (configured=${configured})`, async () => {
    const { DshCoreRuntime } = await import('../../../src/dsh/core-runtime.js')
    const fixture = await makeRegisteredDatabase()
    const db = openConnection(fixture.databasePath)
    let release!: () => void, entered!: () => void, closes = 0, uses = 0
    const held = new Promise<void>(resolve => { release = resolve })
    const acquired = new Promise<void>(resolve => { entered = resolve })
    const tracked = new Proxy(db, { get(target, property) {
      if (property === 'close') return () => { closes++; target.close() }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? (...args: unknown[]) => { uses++; return value.apply(target, args) } : value
    } })
    const runtime = new DshCoreRuntime({repositoryRoot:fixture.root,databasePath:fixture.databasePath,
      initializeDatabase:()=>undefined,openDatabase:async()=>{entered();await held;return tracked},
      ...(configured ? {embeddingConfig:{mode:'off' as const,provider:'openai-compatible' as const,allowRemote:false,vectorBackend:'auto' as const,timeoutMs:1000,batchSize:1}} : {})})
    const startup = assert.rejects(runtime.start(), /runtime is closed/)
    const write = assert.rejects(runtime.enqueueWrite(()=>{uses++}), /runtime is closed/)
    const agent = assert.rejects(runtime.openAgent({dshSessionId:'late',turn:1}), /runtime is closed/)
    try {
      await acquired
      let closed=false
      const closing=runtime.close().then(()=>{closed=true})
      await new Promise(resolve=>setTimeout(resolve,80))
      assert.equal(closed,true,'close must not wait for the held opener')
      await closing
      await Promise.all([startup,write,agent])
      assert.equal(closes,0,'unpublished connection remains owned by the opener until it settles')
      release()
      await new Promise(resolve=>setImmediate(resolve))
      assert.equal(closes,1)
      assert.equal(uses,0,'late connection must not even be probed for embedding settings')
      assert.equal(runtime.activeAgentCount,0)
      await runtime.close()
      assert.equal(closes,1)
    } finally {release();await runtime.close();await new Promise(resolve=>setImmediate(resolve));if(closes===0)db.close();await rm(fixture.root,{recursive:true,force:true})}
  })
}

test('late initializer rejection after close is consumed without reopening runtime', async () => {
  const { DshCoreRuntime } = await import('../../../src/dsh/core-runtime.js')
  let reject!: (reason: Error) => void
  const runtime = new DshCoreRuntime({repositoryRoot:process.cwd(),databasePath:'/tmp/unused-cancelled-runtime.sqlite3',
    initializeDatabase:()=>new Promise((_, fail)=>{reject=fail})})
  const startup=assert.rejects(runtime.start(), /runtime is closed/)
  await runtime.close()
  await startup
  reject(new Error('late initialization failure'))
  await new Promise(resolve=>setImmediate(resolve))
  await assert.rejects(runtime.start(), /runtime is closed/)
})

for (const boundary of ['afterPreflight','afterWritableOpen','beforeCommit'] as const) {
  test(`default initializer cancels at ${boundary} and leaves no committed migrations`, async () => {
    const { initializeDatabase } = await import('../../../src/dsh/database.js')
    const root=await mkdtemp(join(tmpdir(),'kiokuko-init-cancel-'))
    const path=join(root,'index.sqlite3'), controller=new AbortController()
    try {
      await assert.rejects(initializeDatabase({databasePath:path,signal:controller.signal}, {
        [boundary]:()=>controller.abort(new Error('cancel migration')),
      }), /cancel migration/)
      if (boundary==='afterPreflight') await assert.rejects(access(path))
      else {
        const db=openConnection(path)
        try {
          assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length,0)
          db.exec('BEGIN EXCLUSIVE; CREATE TABLE cancellation_cleanup(value TEXT); COMMIT')
        } finally {db.close()}
      }
    } finally {await rm(root,{recursive:true,force:true})}
  })
}
