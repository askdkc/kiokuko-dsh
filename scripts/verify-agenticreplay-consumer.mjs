import { completeVerification } from './verification-completion.mjs';
// Real empty-consumer installation. No global/development AgenticReplay dependency is used.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const exec = promisify(execFile)
const root = process.cwd()
const packageManager = process.argv.includes('--pnpm') ? 'pnpm' : 'npm'
const temporary = await mkdtemp(join(tmpdir(), 'kiokuko-agenticreplay-consumer-'))
// Match the reproducibility check: an empty consumer must not inherit a
// developer's npm build-approval configuration. Lifecycle scripts stay disabled.
const userConfig = join(temporary, 'npmrc')
await writeFile(userConfig, '')
const env = { ...process.env, npm_config_cache: join(temporary, 'cache'), npm_config_userconfig: userConfig, NPM_CONFIG_USERCONFIG: userConfig }
delete env.npm_config_allow_scripts
delete env.NPM_CONFIG_ALLOW_SCRIPTS
try {
  const packed = process.env.KIOKUKO_VERIFY_TARBALL ? null : JSON.parse((await exec('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], { cwd: root, env })).stdout)[0]
  const consumer = join(temporary, 'consumer')
  await mkdir(consumer)
  await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n')
  const archive = process.env.KIOKUKO_VERIFY_TARBALL ?? join(temporary, packed.filename)
  const installArgs = packageManager === 'pnpm'
    ? ['add', '--ignore-scripts', '--no-optional', '--config.minimumReleaseAge=0', archive]
    : ['install', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', archive]
  await exec(packageManager, installArgs,
    { cwd: consumer, env, timeout: 180_000, maxBuffer: 4_194_304 })
  await writeFile(join(consumer, 'verify.mjs'), `
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { createRequire, findPackageJSON } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Config, DshRuntime, DshAgenticReplayStore, DshAgenticReplayRecorder, DshAgenticReplayReadService, resolveDshAgenticReplayRunDirectory } from 'kiokuko-dsh/dsh';
const plugin = createRequire(import.meta.resolve('kiokuko-dsh/dsh'));
const distribution = createRequire(plugin.resolve('agenticreplay'));
const coreEntry = distribution.resolve('@agenticreplay/core');
const { TraceReader } = await import(pathToFileURL(coreEntry).href);
const { buildTimeline, exportTraceHtml } = await import(pathToFileURL(distribution.resolve('@agenticreplay/viewer')).href);
const root = join(process.cwd(), 'workspace'); await mkdir(root);
const runtime = new DshRuntime({ repositoryRoot: root, databasePath: join(process.cwd(), 'index.sqlite3'), autoRegisterRepository: true,
  embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 1000, batchSize: 1 } });
await runtime.start();
const recorder = new DshAgenticReplayRecorder(Config.parse({}).agenticReplay, op => runtime.withDatabase(async db => await op(new DshAgenticReplayStore(db))));
const binding = { sessionId: 'clean-consumer', workspaceRoot: root, sessionCwd: root, storeRoot: root };
try {
  const samples = [
    '{"password":"FAKEONLY_DUMMY_CREDENTIAL"}',
    '{"https://example.invalid/?token=FAKEONLY_DUMMY_CREDENTIAL":"ordinary"}',
    'OPENAI_API_KEY=FAKEONLY_DUMMY_CREDENTIAL',
    'https://example.invalid/?token=FAKEONLY_DUMMY_CREDENTIAL&token_count=3#keep',
  ];
  const benign = 'ordinary-visible-evidence keyboard=mechanical token_budget=4096';
  const body = samples.join('\\n')+'\\n'+benign;
  for await (const chunk of recorder.stream(binding, { provider: 'fixture', model: 'fixture', system:body, messages:[{role:'user',content:[{type:'text',text:body}]}] }, async function* () {
    yield { type: 'text-delta', index: 0, text: body }; yield { type: 'finish', reason: { kind: 'stop' } };
  })) {}
  await recorder.shutdown();
  const status = recorder.status(binding.sessionId); assert.equal(status.trace.state, 'completed');
  assert.equal(await readFile(join(root, '.gitignore'), 'utf8'), '.agenticreplay/\\n');
  const dir = await resolveDshAgenticReplayRunDirectory(root,status.trace.agenticreplay_run_id);
  assert.equal(status.trace.run_directory,dir);
  const service=new DshAgenticReplayReadService(Config.parse({}).agenticReplay,op=>runtime.withDatabase(async db=>await op(new DshAgenticReplayStore(db))));
  const shown=await service.show(binding,status.trace.agenticreplay_run_id);assert.ok(shown.events.length>0);
  const exported=await service.export(binding,status.trace.agenticreplay_run_id);assert.ok((await readFile(exported)).length>0);
  const installed = JSON.parse(await readFile(findPackageJSON('@agenticreplay/core', coreEntry), 'utf8'));
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.agenticreplay_version, installed.version);
  const reader = await TraceReader.open(dir); const events = await reader.events();
  for(const type of ['model.request','model.response'])assert.ok(events.some(e=>e.type===type));
  const files=[];
  async function inspectFiles(path){for(const entry of await readdir(path,{withFileTypes:true})){const target=join(path,entry.name);if(entry.isDirectory())await inspectFiles(target);else files.push(await readFile(target,'utf8'));}}
  await inspectFiles(dir);
  const html=await readFile(exported,'utf8');
  for(const value of [...files,JSON.stringify(shown),html])assert.ok(!value.includes('FAKEONLY_DUMMY_CREDENTIAL'));
  assert.ok(files.join(' ').includes(benign));assert.ok(html.includes(benign));
  assert.equal(buildTimeline(events).length, events.length);
  assert.ok((await exportTraceHtml(dir, join(root, 'fixture.html'))).bytes > 0);
  console.log(JSON.stringify({ packageManager: '${packageManager}', automaticRuntimeDependencies: 'passed', agenticreplayVersion: installed.version, events: events.length, exactReplay: false }));
} finally { await recorder.shutdown(); await runtime.close(); }
`)
  const result = await exec(process.execPath, ['verify.mjs'], { cwd: consumer, env, timeout: 30_000 })
  process.stdout.write(result.stdout)
} finally { await rm(temporary, { recursive: true, force: true }) }

completeVerification({});
