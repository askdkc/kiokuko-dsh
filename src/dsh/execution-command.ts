/** Normalize only a simple shell argv. Compound scripts keep exact identity. */
export function executionCommand(command:string):string {
  const args=shellArguments(command)
  if(!args)return command
  return args.map(arg=>/^[A-Za-z0-9_./:=+@%-]+$/u.test(arg)?arg:JSON.stringify(arg)).join(' ')
}
export function shellArguments(command:string):string[]|undefined {
  if(/[;&|><`$\n\r*?\[\]{}()]/u.test(command))return undefined
  const args:string[]=[];let token='',quote='',started=false
  for(let i=0;i<command.length;i++) {
    const c=command[i]!
    if(quote){if(c===quote)quote='';else token+=c;continue}
    if(c==="'"||c==='"'){quote=c;started=true;continue}
    if(c==='\\'){if(!command[i+1])return undefined;token+=command[++i];started=true;continue}
    if(/\s/u.test(c)){if(started){args.push(token);token='';started=false};continue}
    token+=c;started=true
  }
  if(quote)return undefined
  if(started)args.push(token)
  return args
}
