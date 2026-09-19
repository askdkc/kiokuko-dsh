import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { NodeSqliteAdapter } from '../dist/db/adapter.js'
import { LispConfig } from '../dist/dsh/lisp/contracts.js'
import { LispManager } from '../dist/dsh/lisp/manager.js'
import { LispStore } from '../dist/dsh/lisp/store.js'
import { HttpTypeSafeClient } from '../dist/dsh/typesafe/client.js'
import { TypeSafeCredentials } from '../dist/dsh/typesafe/credentials.js'

// Deliberately opt-in: no project files or ambient transcript become API input.
if (process.argv.length !== 3 || process.argv[2] !== '--live') {
  console.error('Explicit live invocation required: node scripts/smoke-typesafe.mjs --live')
  process.exit(1)
}
const credentials = new TypeSafeCredentials(() => undefined)
if (!(await credentials.status()).configured) {
  console.error('TYPESAFE_API_KEY must be available in the host environment. No request was made.')
  process.exit(1)
}
const base = await realpath(await mkdtemp(join(tmpdir(), 'kiokuko-typesafe-smoke-'))), root = join(base, 'work')
await mkdir(root)
const db = new NodeSqliteAdapter(join(base, 'db.sqlite3'), new DatabaseSync(join(base, 'db.sqlite3')))
db.exec(await readFile(new URL('../migrations/019_dsh_lisp.sql', import.meta.url), 'utf8'))
const client = new HttpTypeSafeClient(credentials)
const manager = new LispManager({ store: new LispStore(async fn => fn(db)), dataRoot: join(base, 'data'),
  config: LispConfig.parse({ enabled: true, sbclPath: process.env.KIOKUKO_LISP_SBCL ?? 'sbcl', startupTimeoutMs: 60000 }),
  typesafeCall: (_owner, method, args, context) => method === 'typesafe-status' ? client.status() : client.evaluate(args, context.signal),
})
const owner = { sessionId: 'synthetic-smoke', agentId: 'synthetic-agent', root }
try {
  await manager.start(); await manager.enable(owner)
  const questions = Object.fromEntries(['early', 'awaited'].map(id => [id, { type: 'noul', instructions: `Does function ${id} return before the save promise settles?` }]))
  const state = 'async function early(x) { save(x); return "done"; }\nasync function awaited(x) { await save(x); return "done"; }'
  const code = `(let* ((r (kioku.typesafe:evaluate ${JSON.stringify(state).replaceAll('\\n', '\n')}
                    (kioku.data:parse-json ${JSON.stringify(JSON.stringify(questions))}) :model ${JSON.stringify(process.env.TYPESAFE_SMOKE_MODEL ?? 'jev-latest')}))
                      (answers (gethash "answers" r)) (decisions (make-hash-table :test 'equal)))
                 (maphash (lambda (id answer) (setf (gethash id decisions)
                   (if (> (gethash "noul" answer) 0.5) "inspect-await-and-caller" "inspect-other-causes"))) answers)
                 (setf (gethash "observedDecisions" r) decisions) r)`
  const result = await manager.execute(owner, 'lisp_eval', { operationId: 'synthetic-batch', code })
  if (!result.ok || !result.value?.json?.observedDecisions) throw new Error('SMOKE_FAILED')
  console.log(JSON.stringify({ live: true, ...result.value.json, note: 'Observed decisions; the demonstration cutoff is not an approval or correctness threshold.' }, null, 2))
} catch (error) {
  // Never print arbitrary provider/transport exception messages or worker diagnostics.
  console.error(`TypeSafe live Lisp smoke failed (${typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'SMOKE_FAILED'}). No automatic retry was made.`)
  process.exitCode = 1
} finally { await manager.dispose(); db.close(); await rm(base, { recursive: true, force: true }) }
