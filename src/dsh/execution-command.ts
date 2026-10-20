/** Bump whenever identity semantics change; historical receipts are not proof. */
export const EXECUTION_COMMAND_VERSION = 3
/** Shell source is not argv: quoting changes assignments/reserved words and
 * expansion. Never infer equivalence with the protective argument recognizer. */
export function executionCommand(command:string):string {
  return JSON.stringify({version:EXECUTION_COMMAND_VERSION,raw:command})
}
export function shellArguments(command:string):string[]|undefined {
  if(/[;&|><`$\n\r*?\[\]{}()~#]/u.test(command) || /[^\S \t]/u.test(command))return undefined
  const args:string[]=[];let token='',quote='',started=false
  for(let i=0;i<command.length;i++) {
    const c=command[i]!
    if(quote){
      if(c===quote)quote=''
      else if(quote==='"'&&c==='\\'&&['"','\\'].includes(command[i+1]??''))token+=command[++i]
      else token+=c
      continue
    }
    if(c==="'"||c==='"'){quote=c;started=true;continue}
    if(c==='\\'){if(!command[i+1])return undefined;token+=command[++i];started=true;continue}
    if(/\s/u.test(c)){if(started){args.push(token);token='';started=false};continue}
    token+=c;started=true
  }
  if(quote)return undefined
  if(started)args.push(token)
  return args
}

/** Only direct shell pipelines, not a quoted literal or boolean OR. This is
 * deliberately not an interpreter or a claim about programs invoked by a script.
 * Aggregate exit status alone cannot attest every stage of a pipeline. */
export function hasShellPipeline(command: string): boolean {
  let quote = ''
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (c === '\\' && quote !== "'") { i++; continue }
    if (quote) { if (c === quote) quote = ''; continue }
    if (c === "'" || c === '"') { quote = c; continue }
    if (c === '|') { if (command[i + 1] === '|') { i++; continue }; return true }
  }
  return false
}

/** Conservative throttling only. Similar argv may mean DIFFERENT shell source
 * (assignment/reserved words), so this must never be used to grant proof or
 * authority. A false positive here delays a retry; exact raw identity owns proof. */
export function mayRepeatCommand(left: string, right: string): boolean {
  if (left === right) return true
  const a = shellArguments(left), b = shellArguments(right)
  if (!a || !b) return false
  const reserved = new Set(['!', 'if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'select', 'while', 'until', 'do', 'done', 'in', 'function', 'time', 'coproc'])
  // A quote change here can FIX the shell syntax rather than repeat a command.
  if ([a[0], b[0]].some(word => !word || word.includes('=') || reserved.has(word))) return false
  return JSON.stringify(a) === JSON.stringify(b)
}
