import { appendFileSync, readFileSync } from 'node:fs'
import { openConnection } from '../../../../src/db/connection.js'
import { MemoryReviewWorker } from '../../../../src/memory/review/worker.js'
import type { DshLogEvent } from '../../../../src/dsh/session-memory-finalizer.js'
const [databasePath,sourcePath,callsPath]=process.argv.slice(2)
const db=openConnection(databasePath!)
const events=JSON.parse(readFileSync(sourcePath!,'utf8')) as DshLogEvent[]
const worker=new MemoryReviewWorker({runtime:{withDatabase:async operation=>operation(db,undefined as never)},source:{async sourceGeneration(){return 'generation'},async *streamRange(){yield*events}},
 llm:{async *stream(request){appendFileSync(callsPath!,'provider reached\n');if(request.tools?.length)throw new Error('tools must be empty');await new Promise(r=>setTimeout(r,50));yield {type:'text-delta',text:'{"schemaVersion":1,"proposals":[]}'};yield {type:'finish',reason:{kind:'stop'}}}}})
worker.kick('project:test');await worker.whenIdle();await worker.dispose();db.close()
