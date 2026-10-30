import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

/** OS birth identity, not PID liveness alone. Unavailable identity stays conservative. */
export function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('INVALID_PROCESS_ID')
  try {
    let birth
    if (process.platform === 'linux') {
      const stat=readFileSync(`/proc/${pid}/stat`,'utf8')
      birth=[readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]]
      if(!/^\d+$/.test(birth[1]??''))throw new Error('INVALID_PROCESS_IDENTITY')
    } else if(process.platform === 'darwin') {
      const started=execFileSync('/bin/ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',timeout:1000,stdio:['ignore','pipe','ignore'],env:{...process.env,LC_ALL:'C',TZ:'UTC'}}).trim()
      if(!started)return undefined
      birth=[started]
    } else return undefined
    return createHash('sha256').update(JSON.stringify([process.platform,pid,...birth])).digest('hex')
  } catch(error) {
    if(['ENOENT','ESRCH'].includes(error.code)||error.status===1)return undefined
    throw error
  }
}

export function sameProcess(pid, identity) {
  try { process.kill(pid,0) } catch(error) { if(error.code==='ESRCH')return false;throw error }
  if(process.platform==='linux'){
    try{const stat=readFileSync(`/proc/${pid}/stat`,'utf8');if(['Z','X'].includes(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]))return false}
    catch(error){if(error.code==='ENOENT')return false;throw error}
  }
  const current=identity?processIdentity(pid):undefined
  return !current || !identity || current===identity
}
