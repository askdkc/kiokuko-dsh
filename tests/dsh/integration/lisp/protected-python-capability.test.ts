import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
// A real OS fixture, including Linux FD 4 seccomp handoff. Fast tests remain partial.
test('protected Python capability launches through the production supervised sandbox', {skip:process.env.KIOKUKO_REQUIRE_LISP_RUNTIME!=='1'?'requires protected native runtime':false},async()=>{
 const result=await promisify(execFile)(process.execPath,[path.resolve('scripts/verify-protected-python-capability.mjs')],{cwd:process.cwd(),env:process.env,timeout:15000,maxBuffer:32768});
 assert.equal(result.stdout.trim(),'protected-python:3');assert.equal(result.stderr,'');
});
