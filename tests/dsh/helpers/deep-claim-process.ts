import { openConnection } from '../../../src/db/connection.js'
import { DeepStore } from '../../../src/deep-thinker/store.js'
const [databasePath, runId, owner] = process.argv.slice(2)
const db = openConnection(databasePath!)
const store = new DeepStore({withDatabase: async operation => operation(db, undefined as never)}, () => 1000)
process.once('message', async () => {
  try { await store.claim(runId!, owner!); process.send?.({claimed:true}) }
  catch (error) { process.send?.({claimed:false,error:String(error)}) }
  finally { db.close(); process.disconnect?.() }
})
process.send?.({ready:true})
