import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
const root=resolve(import.meta.dirname,'..'),profile=join(root,'.artifacts/code-intelligence/profile'),packages=join(profile,'node_modules')
const [boot,cordis]=await Promise.all(['dsh-app-boot','cordis'].map(name=>import(pathToFileURL(join(packages,'@deepseek-ai',name,'lib/index.js')).href)))
const config=boot.loadProfileDirectory('dsh',profile,join(profile,'package.json'),{userLayer:false})
assert.equal(config.skippedBundles.length,0)
const rows=boot.composeEntries(config.layers.map(layer=>layer.patches)),ctx=new cordis.Context()
ctx.provide('profileContext',{dir:profile})
try{
 const entries=boot.prepareProfileEntries(ctx,rows,pathToFileURL(profile+'/').href)
 assert.ok(entries.every(entry=>!entry.disabled),JSON.stringify(entries))
 assert.ok(entries.some(entry=>entry.name==='kiokuko-dsh'))
 assert.ok(entries.some(entry=>entry.name==='@askdkc/dsh-lsp-server/provider'))
 for(const name of ['kiokuko-dsh','@askdkc/dsh-lsp-server']){
  const manifest=JSON.parse(await readFile(join(packages,name,'package.json'),'utf8'))
  assert.equal(boot.evaluatePluginCompatibility(manifest,{},'0.2.1-alpha.2'),undefined)
 }
 const contract=await import(pathToFileURL(join(packages,'@askdkc/dsh-lsp-server/lib/code-intelligence-contracts.js')).href)
 assert.equal(contract.CODE_INTELLIGENCE_VERSION,1);assert.equal(contract.CODE_INTELLIGENCE_SERVICE,'codeIntelligence')
 console.log('Packed CLI profile bundle discovery and DSH alpha.2 preflight passed.')
}finally{await ctx.fiber.dispose()}
