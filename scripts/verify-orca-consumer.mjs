// Real empty-consumer installation. No global/development Orca dependency is used.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const exec = promisify(execFile)
const root = process.cwd()
const temporary = await mkdtemp(join(tmpdir(), 'kiokuko-orca-consumer-'))
const env = { ...process.env, npm_config_cache: join(temporary, 'cache') }
try {
  const packed = JSON.parse((await exec('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], { cwd: root, env })).stdout)[0]
  const consumer = join(temporary, 'consumer')
  await mkdir(consumer)
  await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n')
  await exec('npm', ['install', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', join(temporary, packed.filename)],
    { cwd: consumer, env, timeout: 180_000, maxBuffer: 4_194_304 })
  await writeFile(join(consumer, 'verify.mjs'), `
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { findPackageJSON } from 'node:module';
import { join } from 'node:path';
import { Config, DshRuntime, DshOrcaStore, DshOrcaRecorder } from 'kiokuko-dsh/dsh';
import { TraceReader } from '@orcareplay/core';
import { buildTimeline, exportTraceHtml } from '@orcareplay/viewer';
const root = join(process.cwd(), 'workspace'); await mkdir(root);
const runtime = new DshRuntime({ repositoryRoot: root, databasePath: join(process.cwd(), 'index.sqlite3'), autoRegisterRepository: true,
  embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 1000, batchSize: 1 } });
await runtime.start();
const recorder = new DshOrcaRecorder(Config.parse({}).orca, op => runtime.withDatabase(async db => await op(new DshOrcaStore(db))));
const binding = { sessionId: 'clean-consumer', workspaceRoot: root, sessionCwd: root, storeRoot: root };
try {
  for await (const chunk of recorder.stream(binding, { provider: 'fixture', model: 'fixture', messages: [] }, async function* () {
    yield { type: 'text-delta', index: 0, text: 'consumer fixture' }; yield { type: 'finish', reason: { kind: 'stop' } };
  })) {}
  await recorder.shutdown();
  const status = recorder.status(binding.sessionId); assert.equal(status.trace.state, 'completed');
  const dir = join(root, '.orca/runs', status.trace.orca_run_id);
  const installed = JSON.parse(await readFile(findPackageJSON('@orcareplay/core', import.meta.url), 'utf8'));
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.orca_version, installed.version);
  const reader = await TraceReader.open(dir); const events = await reader.events();
  assert.equal(buildTimeline(events).length, events.length);
  assert.ok((await exportTraceHtml(dir, join(root, 'fixture.html'))).bytes > 0);
  console.log(JSON.stringify({ automaticRuntimeDependencies: 'passed', orcaVersion: installed.version, events: events.length, exactReplay: false }));
} finally { await recorder.shutdown(); await runtime.close(); }
`)
  const result = await exec(process.execPath, ['verify.mjs'], { cwd: consumer, env, timeout: 30_000 })
  process.stdout.write(result.stdout)
} finally { await rm(temporary, { recursive: true, force: true }) }
