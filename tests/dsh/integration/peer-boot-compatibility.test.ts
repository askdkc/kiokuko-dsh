import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';

test('the actual published DSH boot validator accepts peer ranges and rejects breaking prereleases without exemptions',async () => {
 const root=process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? resolve('tests/fixtures/dsh-runtime/node_modules');
 const boot=await import(pathToFileURL(join(root,'@deepseek-ai/dsh-app-boot/lib/index.js')).href);
 const manifest=JSON.parse(await readFile('package.json','utf8'));
 for(const version of ['0.2.1-alpha.2','0.2.1-alpha.3','0.2.1','0.2.2'])assert.equal(boot.evaluatePluginCompatibility(manifest,{},version),undefined,version);
 for(const version of ['0.1.9','0.2.0','0.2.1-alpha.1','0.3.0-alpha.1','0.3.0','1.0.0']) {
  const mismatch=boot.evaluatePluginCompatibility(manifest,{},version);assert.ok(mismatch,version);assert.equal(mismatch.exempted,false);
 }
 assert.equal(boot.evaluatePluginCompatibility(manifest,{},boot.getDshRuntimeVersion()),undefined);
});
