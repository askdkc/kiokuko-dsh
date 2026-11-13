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
import { mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createRequire, findPackageJSON } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Config, DshRuntime, DshAgenticReplayStore, DshAgenticReplayRecorder, DshAgenticReplayReadService, resolveDshAgenticReplayRunDirectory } from 'kiokuko-dsh/dsh';
const plugin = createRequire(import.meta.resolve('kiokuko-dsh/dsh'));
const distribution = createRequire(plugin.resolve('agenticreplay'));
const coreEntry = distribution.resolve('@agenticreplay/core');
const schema = createRequire(distribution.resolve('@agenticreplay/schema'));
const ajv = createRequire(schema.resolve('ajv'));
const { gte } = plugin('semver');
const fastUriVersion = ajv('fast-uri/package.json').version;
assert.ok(gte(fastUriVersion, '3.1.9'), 'the installed AJV must resolve patched fast-uri');
const distributionVersion = JSON.parse(await readFile(findPackageJSON('agenticreplay', plugin.resolve('agenticreplay')), 'utf8')).version;
const { TraceReader, compactRun } = await import(pathToFileURL(coreEntry).href);
const { buildTimeline, exportTraceHtml, readTraceDir } = await import(pathToFileURL(distribution.resolve('@agenticreplay/viewer')).href);
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
  const body = samples.join('\\n')+'\\n'+benign.repeat(800);
  for await (const chunk of recorder.stream(binding, { provider: 'fixture', model: 'fixture', system:body, messages:[{role:'user',content:[{type:'text',text:body}]}] }, async function* () {
    yield { type: 'text-delta', index: 0, text: body }; yield { type: 'finish', reason: { kind: 'stop' } };
  })) {}
  for await (const chunk of recorder.stream(binding, { provider: 'fixture', model: 'fixture', messages: [] }, async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMITED', status: 429, requestId: 'consumer-request-1', message: 'Capacity exceeded; authorization FAKEONLY_DUMMY_CREDENTIAL' } } };
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
  assert.equal(installed.version, distributionVersion);
  assert.ok(gte(installed.version, '0.1.22'));
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  assert.ok(manifest.counts.blobs > 0, 'exercise redaction through blob storage');
  assert.equal(manifest.agenticreplay_version, installed.version);
  const reader = await TraceReader.open(dir); const events = await reader.events();
  const failure = events.find(e => e.type === 'error' && e.attrs?.diagnostic?.requestId === 'consumer-request-1');
  assert.equal(failure?.attrs?.diagnostic?.status, 429);
  assert.equal(failure?.attrs?.diagnostic?.code, 'RATE_LIMITED');
  const loaded = events.find(e => e.type === 'run.start').payload.runtime;
  const packaged = JSON.parse(await readFile(new URL('./build-info.json', import.meta.resolve('kiokuko-dsh')), 'utf8'));
  assert.equal(loaded.loadedFrom, 'distribution'); assert.equal(loaded.buildId, packaged.buildId);
  assert.match(loaded.buildId, /^[a-f0-9]{64}$/u); assert.equal(loaded.pluginVersion, packaged.packageVersion);
  for(const type of ['model.request','model.response'])assert.ok(events.some(e=>e.type===type));
  const files=[];
  async function inspectFiles(path){for(const entry of await readdir(path,{withFileTypes:true})){const target=join(path,entry.name);if(entry.isDirectory())await inspectFiles(target);else {const bytes=await readFile(target);files.push((entry.name.endsWith('.gz')?gunzipSync(bytes):bytes).toString('utf8'));}}}
  await inspectFiles(dir);
  const html=await readFile(exported,'utf8');
  for(const value of [...files,JSON.stringify(shown),html])assert.ok(!value.includes('FAKEONLY_DUMMY_CREDENTIAL'));
  assert.ok(files.join(' ').includes(benign));assert.ok(html.includes(benign));
  assert.equal(buildTimeline(events).length, events.length);
  assert.ok((await exportTraceHtml(dir, join(root, 'fixture.html'))).bytes > 0);
  const viewerEntry = distribution.resolve('@agenticreplay/viewer');
  const viewerVersion = JSON.parse(await readFile(findPackageJSON('@agenticreplay/viewer', viewerEntry), 'utf8')).version;
  assert.equal(viewerVersion, distributionVersion);
  assert.equal(typeof compactRun, 'function', 'installed core must expose compactRun');
  // Do not equate a version floor or nonempty HTML with gzip compatibility.
  const before = await readTraceDir(dir);
  assert.equal(before.omittedBlobs, 0);
  assert.ok(Object.keys(before.blobs).length > 0);
  const blobs = [];
  for (const shard of await readdir(join(dir, 'blobs'), { withFileTypes: true })) {
    if (!shard.isDirectory()) continue;
    for (const name of await readdir(join(dir, 'blobs', shard.name))) {
      if (!/^[a-f0-9]{64}(?:[.]gz)?$/u.test(name)) continue;
      const path = join(dir, 'blobs', shard.name, name);
      const compressed = name.endsWith('.gz');
      const bytes = await readFile(path);
      blobs.push({ path, hex: name.slice(0, 64), bytes: compressed ? gunzipSync(bytes) : bytes, compressed });
    }
  }
  assert.ok(blobs.length > 0);
  for (const blob of blobs) {
    assert.ok(!blob.bytes.toString('utf8').includes('FAKEONLY_DUMMY_CREDENTIAL'));
    if (!blob.compressed) {
      await writeFile(blob.path + '.gz', gzipSync(blob.bytes), { mode: 0o600 });
      await rm(blob.path);
    }
  }
  // Independent checks report every broken consumer without printing payloads.
  const checks = {};
  async function verifyConsumers(prefix) {
    async function check(name, verify) {
      try { await verify(); checks[prefix + name] = 'passed'; }
      catch { checks[prefix + name] = 'failed'; }
    }
    await check('coreGzip', async () => {
      const compressedReader = await TraceReader.open(dir);
      assert.deepEqual(await compressedReader.events(), events);
      assert.equal((await compressedReader.verifyIntegrity()).ok, true);
      for (const blob of blobs) assert.deepEqual(Buffer.from(await compressedReader.blob('sha256:' + blob.hex)), blob.bytes);
    });
    await check('viewerGzip', async () => {
      const after = await readTraceDir(dir);
      assert.equal(after.omittedBlobs, 0);
      assert.deepEqual(after.blobs, before.blobs);
      assert.deepEqual(after.events, before.events);
      const result = await exportTraceHtml(dir, join(root, 'gzip.html'));
      assert.ok(result.bytes > 0);
      const compressedHtml = await readFile(result.path, 'utf8');
      assert.equal(compressedHtml, await readFile(join(root, 'fixture.html'), 'utf8'));
      assert.ok(compressedHtml.includes(benign));
      assert.ok(!compressedHtml.includes('FAKEONLY_DUMMY_CREDENTIAL'));
    });
    await check('dshGzipShow', async () => {
      const after = await service.show(binding, status.trace.agenticreplay_run_id);
      assert.deepEqual(after.events, shown.events);
      assert.deepEqual(after.rows, shown.rows);
      assert.ok(!JSON.stringify(after).includes('FAKEONLY_DUMMY_CREDENTIAL'));
    });
    await check('dshGzipScanAndExport', async () => {
      // The public export performs both bounded scans and the installed Viewer pass.
      const after = await readFile(await service.export(binding, status.trace.agenticreplay_run_id), 'utf8');
      assert.equal(after, html);
      assert.ok(after.includes(benign));
      assert.ok(!after.includes('FAKEONLY_DUMMY_CREDENTIAL'));
    });
  }
  await verifyConsumers('');
  // Restore legacy plain storage using the real writer's decoded bytes. New
  // writers already gzip large blobs, which would otherwise make compact a no-op.
  for (const blob of blobs) {
    const plainPath = blob.compressed ? blob.path.slice(0, -3) : blob.path;
    await writeFile(plainPath, blob.bytes, { mode: 0o600 });
    await rm(plainPath + '.gz');
  }
  const plain = await readTraceDir(dir);
  assert.equal(plain.omittedBlobs, 0);
  assert.deepEqual(plain.blobs, before.blobs);
  assert.deepEqual(plain.events, before.events);
  const manifestBeforeCompact = await readFile(join(dir, 'manifest.json'));
  const eventsBeforeCompact = await readFile(join(dir, 'events.jsonl'));
  const compact = await compactRun(dir);
  assert.equal(compact.reason, undefined);
  assert.notEqual(compact.pending, true);
  assert.ok(compact.converted > 0, 'compact must actually convert writer-produced blobs');
  assert.ok(compact.savedBytes > 0, 'compact must reclaim storage');
  assert.deepEqual(await readFile(join(dir, 'manifest.json')), manifestBeforeCompact);
  assert.deepEqual(await readFile(join(dir, 'events.jsonl')), eventsBeforeCompact);
  await verifyConsumers('compact:');
  files.length = 0;
  await inspectFiles(dir);
  for (const value of files) assert.ok(!value.includes('FAKEONLY_DUMMY_CREDENTIAL'));
  assert.ok(files.join(' ').includes(benign));
  console.log(JSON.stringify({ packageManager: '${packageManager}', agenticreplayVersion: installed.version, viewerVersion,
    fastUriVersion, events: events.length, blobs: blobs.length, gzip: checks, compact, exactReplay: false }));
  assert.ok(Object.values(checks).every(value => value === 'passed'), 'installed consumers must preserve gzip blob content');
} finally { await recorder.shutdown(); await runtime.close(); }
`)
  const result = await exec(process.execPath, ['verify.mjs'], { cwd: consumer, env, timeout: 30_000 })
  process.stdout.write(result.stdout)
} finally { await rm(temporary, { recursive: true, force: true }) }

completeVerification({});
