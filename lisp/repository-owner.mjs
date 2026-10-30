// The existing supervisor holds this OS-backed SQLite lock until its runtime exits.
// The user directory is independent of DSH's DB, session and worker TMPDIR.
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { processIdentity, sameProcess } from './process-identity.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function claimRepository(root) {
  const canonical = realpathSync(root)
  const directory = join(process.platform === 'win32' ? tmpdir() : '/tmp', `kiokuko-lisp-owners-${process.getuid?.() ?? 'user'}`)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077))
    throw new Error('REPOSITORY_LOCK_DIRECTORY')
  const path = join(directory, `${createHash('sha256').update(canonical).digest('hex')}.sqlite3`)
  try { const file=lstatSync(path);if (!file.isFile() || file.isSymbolicLink()) throw new Error('REPOSITORY_LOCK_FILE') }
  catch(error) { if(error.code !== 'ENOENT') throw error }
  const db = new DatabaseSync(path)
  const metadata=path+'.owner.json',token=randomUUID()
  try {
    // Opening a new SQLite file briefly takes reader locks in *both* contenders.
    // A zero busy timeout can make both exclusive acquisitions fail before
    // either owns the repository. Allow those short initialization reads to
    // drain; an existing owner's lifetime transaction still rejects in 250ms.
    db.exec('PRAGMA busy_timeout=250; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS repository_owner(root TEXT NOT NULL)')
    try {
      const owner=JSON.parse(readFileSync(metadata,'utf8'))
      if(!Number.isSafeInteger(owner.pid)||owner.pid<1||owner.root!==canonical||typeof owner.token!=='string'
        ||owner.identity!==null&&!/^[a-f0-9]{64}$/.test(owner.identity))throw new Error('REPOSITORY_LOCK_METADATA')
      // A supervisor killed before cleanup must not donate its still-live runtime.
      if(sameProcess(owner.pid,owner.identity??undefined))throw new Error('REPOSITORY_IN_USE')
    } catch(error) { if(error.code!=='ENOENT')throw error }
    db.prepare('DELETE FROM repository_owner').run()
    db.prepare('INSERT INTO repository_owner VALUES(?)').run(canonical)
    let recorded=false
    return {
      recordRuntime(pid){
        const temporary=metadata+'.'+token
        const identity=processIdentity(pid)??null
        writeFileSync(temporary,JSON.stringify({root:canonical,pid,identity,token})+'\n',{flag:'wx',mode:0o600})
        renameSync(temporary,metadata);recorded=true
        return identity
      },
      close(){
        // Called only after runtime exit. A crash leaves evidence for the next owner.
        if(recorded){const owner=JSON.parse(readFileSync(metadata,'utf8'));if(owner.token===token)unlinkSync(metadata)}
        db.close()
      },
    } // Transaction stays uncommitted; the OS releases it when this supervisor dies.
  } catch(error) {
    db.close()
    if(error.errcode === 5 || error.code === 'SQLITE_BUSY') throw new Error('REPOSITORY_IN_USE')
    throw error
  }
}
