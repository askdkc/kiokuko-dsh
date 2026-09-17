import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'
import { mountLispSurface } from '../../../../src/dsh/lisp/surface.js'
import type { DshRuntime } from '../../../../src/dsh/runtime.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT
test('uploaded binary reaches protected Lisp through the native attachment service and current session only', {
  skip: !packages || process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires native DSH and protected SBCL' : false, timeout: 120000,
}, async () => {
  const [cordis, prompt, tools, scope, attachment, sessionModule] = await Promise.all(
    ['cordis', 'dsh-system-prompt', 'dsh-tools', 'dsh-scope', 'dsh-attachment-local', 'dsh-session']
      .map(name => import(pathToFileURL(join(packages!, '@deepseek-ai', name, 'lib/index.js')).href)))
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-attachment-'))), workspace = join(base, 'workspace')
  await mkdir(workspace)
  const db = new NodeSqliteAdapter(join(base, 'db.sqlite3'), new DatabaseSync(join(base, 'db.sqlite3')))
  db.exec(await readFile(new URL('../../../../migrations/019_dsh_lisp.sql', import.meta.url), 'utf8'))
  const runtime = { withDatabase: async (fn: (db: NodeSqliteAdapter) => unknown) => fn(db) } as unknown as DshRuntime
  const ctx = new cordis.Context(), fibers: any[] = [], commands = new Map<string, any>()
  const session = sessionModule.Session.create('attachment-session', [], { version: 3, id: 'attachment-session', createdAt: Date.now(), isSeeded: false, cwd: workspace })
  const agent: any = { id: 'attachment-agent', session }
  let surface: Awaited<ReturnType<typeof mountLispSurface>> | undefined, local: any
  try {
    fibers.push(await ctx.plugin(prompt.default, {}), await ctx.plugin(tools.default, { mode: 'native' }),
      await ctx.plugin(attachment.default, { dshHome: join(base, 'dsh') }))
    fibers.push(await ctx.plugin({ name: 'attachment-session-fixture', apply(c: any) {
      c.provide('agents', { get: (id: string) => id === agent.id ? agent : undefined })
      c.provide('sessions', { get: (id: string) => id === session.id ? session : undefined })
      c.provide('commands', { register: (d: any) => { commands.set(d.name, d); return () => commands.delete(d.name) } })
    } }))
    local = scope.createScope(ctx, agent); agent.ctx = local.ctx
    const bytes = Buffer.from([0x50, 0x4b, 0, 255, 1, 2])
    const ref = await ctx.attachments.saveFile({ data: bytes, name: 'semantic-test.zip' })
    const path = ctx.attachments.fileHostPath(ref)
    session.append('user/message', { role: 'user', id: randomUUID(), source: { kind: 'user' }, content: [{ type: 'file', attachment: ref }] }, { surfaceOp: 'append' })
    surface = await mountLispSurface(ctx, runtime, LispConfig.parse({ enabled: true, sbclPath: process.env.KIOKUKO_LISP_SBCL ?? 'sbcl', startupTimeoutMs: 60000 }))
    const enabled = await commands.get('kioku-lisp').handler({ rawInput: 'enable', agent, signal: new AbortController().signal })
    assert.equal(enabled.kind, 'success', enabled.text)
    const evaluate = async (code: string, inputs: string[]) => {
      const result: any = await ctx.tools.execute({ callId: randomUUID(), name: 'lisp_eval', arguments: { operationId: randomUUID(), code, inputs }, agent, signal: new AbortController().signal })
      assert.equal(result.isError, false, JSON.stringify(result))
      return JSON.stringify(result)
    }
    const readBytes = '(with-open-file (s (kioku.files:input 0) :element-type \'(unsigned-byte 8)) (loop for b = (read-byte s nil) while b collect b))'
    assert.match(await evaluate(readBytes, [path]), /80 75 0 255 1 2/)
    const other = await ctx.attachments.saveFile({ data: Buffer.from('other session'), name: 'other.txt' })
    assert.match(await evaluate('(error "must not execute")', [ctx.attachments.fileHostPath(other)]), /ATTACHMENT_NOT_IN_SESSION/)
    assert.match(await evaluate('(error "must not execute")', [join(base, 'db.sqlite3')]), /ATTACHMENT_NOT_IN_SESSION/)
    assert.match(await evaluate(`(handler-case (progn (with-open-file (s ${JSON.stringify(path)}) (read-char s)) :escaped) (file-error () :denied))`, []), /DENIED/)
    assert.match(await evaluate('(handler-case (progn (with-open-file (s (kioku.files:input 0) :direction :output :if-exists :supersede) (write-string "changed" s)) :escaped) (file-error () :denied))', [path]), /DENIED/)
    await writeFile(join(workspace, 'local.txt'), 'workspace input')
    assert.match(await evaluate('(kioku.files:read-text (kioku.files:input 0))', ['local.txt']), /workspace input/)
    assert.deepEqual(await readFile(path), bytes)
  } finally {
    surface?.stop(); await surface?.dispose(); await local?.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    db.close(); await rm(base, { recursive: true, force: true })
  }
})
