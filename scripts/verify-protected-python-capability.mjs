// Probe the actual protected subprocess path, not Apple's unsandboxed launcher version.
import assert from 'node:assert/strict';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {prepareLayout,sandboxLaunch} from '../dist/dsh/lisp/sandbox.js';
const root=path.resolve(import.meta.dirname,'..');const base=await realpath(await mkdtemp(path.join(tmpdir(),'kiokuko-python-capability-')));
try{const layout=await prepareLayout(base,path.join(root,'lisp'));layout.protected=true;
 const launch=await sandboxLaunch(layout,process.env.KIOKUKO_PYTHON_BIN??'python3',['-I','-c','import sys; print("protected-python:"+str(sys.version_info.major))'],'capability');
 const result=await promisify(execFile)(process.execPath,[path.join(layout.library,'supervisor.mjs'),JSON.stringify({...launch,env:undefined,protocol:false})],{cwd:launch.cwd,env:launch.env,timeout:10000,maxBuffer:16384,killSignal:'SIGTERM'});assert.equal(result.stdout.trim(),'protected-python:3');console.log(result.stdout.trim());
}finally{await rm(base,{recursive:true,force:true});}
