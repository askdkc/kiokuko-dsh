import type {SqliteDatabase} from '../db/adapter.js'
import {rollbackFailedTransaction} from '../db/transaction.js'

/** Optional memory does not borrow the host's five-second lock wait/retry budget. */
export function withOptionalMemoryAccess<T>(db:SqliteDatabase,operation:()=>T):T {
  const previous=db.prepare('PRAGMA busy_timeout').get<{timeout:number}>()!.timeout
  db.exec('PRAGMA busy_timeout=0')
  try{return operation()}finally{db.exec(`PRAGMA busy_timeout=${previous}`)}
}
export function withOptionalMemoryTransaction<T>(db:SqliteDatabase,operation:()=>T,readOnly=false):T {
  return withOptionalMemoryAccess(db,()=>{
    db.exec(readOnly?'BEGIN DEFERRED':'BEGIN IMMEDIATE')
    let result:T
    try{result=operation()}catch(error){rollbackFailedTransaction(db,error)}
    try{db.exec('COMMIT')}catch(error){rollbackFailedTransaction(db,error)}
    return result
  })
}
