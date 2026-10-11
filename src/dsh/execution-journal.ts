import {mkdir,open,readFile,rename,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import type {ExecutionReceipt} from './owned-execution.js'

export interface JournalRecord {digest:string;receipt:ExecutionReceipt}
/** Local outbox survives a failed SQLite save. It contains no command output. */
export class ExecutionJournal {
  constructor(readonly directory:string) {}
  private filename(id:string):string {
    if(!/^[a-f0-9]{64}$/u.test(id))throw new Error('Invalid execution operation ID')
    return join(this.directory,id+'.json')
  }
  async read(id:string):Promise<JournalRecord|undefined> {
    try{return JSON.parse(await readFile(this.filename(id),'utf8')) as JournalRecord}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error}
  }
  private async write(filename:string,record:JournalRecord):Promise<void> {
    const file=await open(filename,'wx',0o600)
    try{await file.writeFile(JSON.stringify(record));await file.sync()}finally{await file.close()}
  }
  private async syncDirectory():Promise<void> {
    const directory=await open(this.directory,'r')
    try{await directory.sync()}finally{await directory.close()}
  }
  async reserve(record:JournalRecord):Promise<boolean> {
    await mkdir(this.directory,{recursive:true,mode:0o700})
    try{await this.write(this.filename(record.receipt.operationId),record);await this.syncDirectory();return true}
    catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return false;throw error}
  }
  async save(record:JournalRecord):Promise<void> {
    const filename=this.filename(record.receipt.operationId),temporary=filename+'.'+randomUUID()
    try{await this.write(temporary,record);await rename(temporary,filename);await this.syncDirectory()}finally{await rm(temporary,{force:true})}
  }
}
