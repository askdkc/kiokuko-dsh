import { LispManager } from '../../../src/dsh/lisp/manager.js'
import { LispStore } from '../../../src/dsh/lisp/store.js'
import { digest, LispConfig } from '../../../src/dsh/lisp/contracts.js'
import { openConnection } from '../../../src/db/connection.js'
import { join } from 'node:path'

const base = process.argv[2]!
const db = openConnection(join(base, 'state.sqlite3'))
const store = new LispStore(async fn => fn(db))
const manager = new LispManager({ store, dataRoot: join(base, 'data'),
  config: LispConfig.parse({ enabled: true, executionMode: 'development', startupTimeoutMs: 60000 }) })
process.on('message', async ({ id, method, owner, input }: any) => {
  try {
    const value = method === 'start' ? await manager.start()
      : method === 'reserve-proposal' ? await store.reserve(owner, input.operationId, 'proposal', digest(input), 'fixture', { before: { path: input.path } })
      : method === 'enable' ? await manager.enable(owner)
      : method === 'recover' ? await manager.recover(owner)
      : method === 'dispose' ? await manager.dispose()
      : await manager.execute(owner, method, input ?? {})
    process.send!({ id, value })
    if (method === 'dispose') { db.close(); process.disconnect() }
  } catch (error) { process.send!({ id, error: { code: (error as any).code, message: String(error) } }) }
})
