import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { packBuiltDsh, restoreBuiltDsh } from './dsh-build-artifact.mjs';
import { stageDshUpstream, upstreamRepository } from './stage-dsh-upstream.mjs';

function fixture(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'shared DSH build '));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, 'producer'), consumer = path.join(base, 'consumer'), artifacts = path.join(base, 'transport');
  mkdirSync(source);
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('remote', 'add', 'origin', upstreamRepository);
  writeFileSync(path.join(source, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.28.5', workspaces: ['apps/*', 'packages/core/*'] }));
  writeFileSync(path.join(source, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  writeFileSync(path.join(source, '.gitignore'), 'lib/\nnode_modules/\n.env\n');
  for (const [directory, name, entry] of [['apps/cli','dsh','bin.js'], ['packages/core/agent-loop','dsh-agent-loop','index.js'], ['packages/core/tools','dsh-tools','index.js']]) {
    const root = path.join(source, directory); mkdirSync(path.join(root, 'lib'), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version: '1.2.3', type: 'module' }));
    writeFileSync(path.join(root, 'lib', entry), name === 'dsh' ? 'import value from "fixture-dependency"; console.log(value + 2);\n' : 'export default 40;\n');
  }
  git('add', '.'); git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
  const sha = git('rev-parse','HEAD');
  execFileSync('git', ['clone','-q',source,consumer]);
  execFileSync('git', ['-C',consumer,'remote','set-url','origin',upstreamRepository]);
  const selection = { request: { dshSha: sha }, digest: 'exact-plan', identity: { toolchain: { node: process.version } },
    dshTargets: [{ key: `${process.platform}-${process.arch}` }] };
  return { base, source, consumer, artifacts, selection };
}

test('shared DSH build relocates through normal staging without copying dependencies or Git credentials', t => {
  const f = fixture(t);
  mkdirSync(path.join(f.source,'node_modules'),{recursive:true});
  writeFileSync(path.join(f.source,'node_modules/producer-only'), 'must not travel');
  const receipt = packBuiltDsh(f.source,f.artifacts,f.selection);
  // A different runner has its own frozen installation, not the producer graph.
  const dependency = path.join(f.consumer,'node_modules/fixture-dependency'); mkdirSync(dependency,{recursive:true});
  writeFileSync(path.join(dependency,'package.json'),JSON.stringify({main:'index.js'}));
  writeFileSync(path.join(dependency,'index.js'),'module.exports = 40;\n');
  rmSync(f.source,{recursive:true,force:true});
  assert.deepEqual(restoreBuiltDsh(f.consumer,f.artifacts,f.selection),receipt);
  assert.equal(existsSync(path.join(f.consumer,'node_modules/producer-only')),false);
  const runtime = path.join(f.base,'runtime'), development = path.join(f.base,'development');
  stageDshUpstream(f.consumer,runtime,f.selection.request.dshSha,development);
  assert.equal(execFileSync(path.join(runtime,'node_modules/.bin/dsh'),[],{encoding:'utf8'}).trim(),'42');
});

test('shared build rejects changed source, lock, platform, ABI, Node, plan and archive before restoring outputs', t => {
  const f = fixture(t), receipt = packBuiltDsh(f.source,f.artifacts,f.selection);
  const file = path.join(f.artifacts,'dsh-build.json'), output = path.join(f.consumer,'apps/cli/lib/bin.js');
  for (const key of ['schema','repository','sha','version','platform','architecture','node','abi','packageManager','lockHash','selectionDigest','archive']) {
    writeFileSync(file, JSON.stringify({...receipt,[key]:'different'}));
    assert.throws(()=>restoreBuiltDsh(f.consumer,f.artifacts,f.selection), /identity mismatch|archive name/);
    assert.equal(existsSync(output),false,key);
  }
  writeFileSync(file,JSON.stringify(receipt));
  assert.throws(()=>restoreBuiltDsh(f.consumer,f.artifacts,{...f.selection,dshTargets:[]}),/Unselected/);
  writeFileSync(path.join(f.consumer,'pnpm-lock.yaml'),'changed\n');
  assert.throws(()=>restoreBuiltDsh(f.consumer,f.artifacts,f.selection),/source changes/);
  execFileSync('git',['-C',f.consumer,'checkout','--','pnpm-lock.yaml']);
  writeFileSync(path.join(f.artifacts,'dsh-build.tar.gz'),'corrupted');
  assert.throws(()=>restoreBuiltDsh(f.consumer,f.artifacts,f.selection),/archive hash mismatch/);
  assert.equal(existsSync(output),false);
});

test('producer rejects missing compiled entries and nonportable links before publishing', t => {
  const f = fixture(t), entry = path.join(f.source,'apps/cli/lib/bin.js');
  const content = readFileSync(entry); rmSync(entry);
  assert.throws(()=>packBuiltDsh(f.source,f.artifacts,f.selection),/Missing compiled/);
  assert.equal(existsSync(f.artifacts),false);
  writeFileSync(entry,content);
  symlinkSync(f.base,path.join(f.source,'apps/cli/lib/outside'));
  assert.throws(()=>packBuiltDsh(f.source,f.artifacts,f.selection),/link escapes/);
  assert.equal(existsSync(f.artifacts),false);
});
