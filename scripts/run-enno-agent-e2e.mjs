import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kiokuko = path.join(repositoryRoot, 'dist', 'bin', 'kiokuko.js');
const requested = process.argv[2];
const clients = requested === 'all' ? ['codex', 'opencode', 'claude'] : [requested];
const definitions = {
  codex: {
    flag: 'RUN_CODEX_E2E', commandEnvironment: 'CODEX_E2E_COMMAND', command: 'codex',
    args: (task) => ['--dangerously-bypass-hook-trust', 'exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', task],
  },
  opencode: {
    flag: 'RUN_OPENCODE_E2E', commandEnvironment: 'OPENCODE_E2E_COMMAND', command: 'opencode',
    args: (task) => ['run', task],
  },
  claude: {
    flag: 'RUN_CLAUDE_E2E', commandEnvironment: 'CLAUDE_E2E_COMMAND', command: 'claude',
    args: (task) => ['-p', task, '--permission-mode', 'acceptEdits'],
  },
};
const maxOutput = 64 * 1024;
const timeoutMs = 5 * 60 * 1000;
const minimumCodex0151Version = [0, 151, 0];

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function execute(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    const append = (current, chunk) => current.byteLength >= maxOutput
      ? current
      : Buffer.concat([current, Buffer.from(chunk).subarray(0, maxOutput - current.byteLength)]);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    }, options.timeoutMs ?? timeoutMs);
    timer.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, timedOut, stdout, stderr, spawnCode: error?.code ?? 'spawn_failed' });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout, stderr, spawnCode: null });
    });
  });
}

async function requireSuccess(command, args, options) {
  const result = await execute(command, args, options);
  if (result.code !== 0) throw new Error(`fixture command failed: ${path.basename(command)} (${result.spawnCode ?? result.code ?? result.signal ?? 'unknown'})`);
}

function parseVersion(output) {
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/u.exec(output);
  return match === null ? null : match.slice(1).map((value) => Number.parseInt(value, 10));
}

function versionAtLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

async function codex0151Preflight(command, root, project, environment, args) {
  const versionResult = await execute(command, ['--version'], {
    cwd: project,
    env: environment,
    timeoutMs: 10_000,
  });
  const versionOutput = `${versionResult.stdout.toString('utf8')}\n${versionResult.stderr.toString('utf8')}`;
  const parsedVersion = parseVersion(versionOutput);
  if (versionResult.code !== 0 || parsedVersion === null) {
    return { status: 'failed', reason: 'codex_version_unavailable' };
  }
  const version = parsedVersion.join('.');
  if (!versionAtLeast(parsedVersion, minimumCodex0151Version)) {
    return { status: 'failed', reason: 'codex_version_below_0.151.0', version };
  }

  const probeHome = path.join(root, 'required-mcp-probe-home');
  await mkdir(path.join(probeHome, '.codex'), { recursive: true });
  await writeFile(path.join(probeHome, '.codex', 'config.toml'), [
    '[mcp_servers.kiokuko_required_failure_probe]',
    `command = ${JSON.stringify(process.execPath)}`,
    'args = ["-e", "process.exit(23)"]',
    'enabled = true',
    'required = true',
    '',
  ].join('\n'));
  const probeEnvironment = {
    ...environment,
    HOME: probeHome,
    CODEX_HOME: path.join(probeHome, '.codex'),
  };
  const startupResult = await execute(command, args('Return exactly: unreachable'), {
    cwd: project,
    env: probeEnvironment,
    timeoutMs: 30_000,
  });
  const startupOutput = `${startupResult.stdout.toString('utf8')}\n${startupResult.stderr.toString('utf8')}`;
  if (startupResult.code === 0
    || !/kiokuko_required_failure_probe/u.test(startupOutput)
    || !/mcp/iu.test(startupOutput)) {
    return {
      status: 'failed',
      reason: startupResult.timedOut ? 'required_mcp_startup_probe_timeout' : 'required_mcp_startup_failure_not_observed',
      version,
      exitCode: startupResult.code,
      stdoutDigest: digest(startupResult.stdout),
      stderrDigest: digest(startupResult.stderr),
    };
  }
  return { status: 'passed', version };
}

async function runClient(client) {
  const definition = definitions[client];
  if (definition === undefined) return { client, status: 'failed', reason: 'unsupported_client' };
  if (process.env[definition.flag] !== '1') return { client, status: 'not-run', reason: `${definition.flag}=1 is not set` };

  const root = await mkdtemp(path.join(tmpdir(), `kiokuko-enno-${client}-e2e-`));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const data = path.join(root, 'data');
  const config = path.join(root, 'config');
  await Promise.all([mkdir(home), mkdir(project), mkdir(data), mkdir(config)]);
  await writeFile(path.join(project, 'add.js'), 'export function add(a, b) { return a - b; }\n');
  await writeFile(path.join(project, 'add.test.js'), "import test from 'node:test'; import assert from 'node:assert/strict'; import { add } from './add.js'; test('adds', () => assert.equal(add(2, 3), 5));\n");
  await writeFile(path.join(project, 'package.json'), '{"type":"module","scripts":{"test":"node --test"}}\n');
  await requireSuccess('git', ['init', '-q'], { cwd: project, timeoutMs: 10_000 });
  await requireSuccess('git', ['add', '.'], { cwd: project, timeoutMs: 10_000 });
  await requireSuccess('git', ['-c', 'user.name=Kiokuko E2E', '-c', 'user.email=kiokuko-e2e@example.invalid', 'commit', '-qm', 'fixture'], { cwd: project, timeoutMs: 10_000 });

  const databasePath = path.join(data, 'kiokuko.sqlite3');
  const environment = {
    ...process.env,
    HOME: home,
    CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    KIOKUKO_DATABASE: databasePath,
  };
  const command = process.env[definition.commandEnvironment] || definition.command;
  let codexChecks;
  if (client === 'codex') {
    const preflight = await codex0151Preflight(command, root, project, environment, definition.args);
    if (preflight.status !== 'passed') return { client, ...preflight };
    codexChecks = {
      version: preflight.version,
      requiredMcpStartup: { status: 'passed' },
      extensionResultMutation: {
        status: 'not-run',
        reason: 'no_external_tool_lifecycle_extension_harness',
        modes: ['direct', 'code-mode'],
      },
      repositoryPluginCatalogIsolation: {
        status: 'not-run',
        reason: 'no_repository_plugin_catalog_fixture',
      },
    };
  }
  await requireSuccess(kiokuko, ['setup', '--clients', client, '--enno-oduno', 'on', '--skill-discovery', 'off', '--json'], {
    cwd: project, env: environment, timeoutMs: 60_000,
  });
  await requireSuccess(kiokuko, ['use', '--root', project, '--json'], { cwd: project, env: environment, timeoutMs: 60_000 });

  const task = 'Use Kiokuko Enno-Oduno. Fix the incorrect add function, keep the public API, and make node --test pass. Use at most three repair loops.';
  const result = await execute(command, definition.args(task), { cwd: project, env: environment, timeoutMs });
  if (result.code !== 0) {
    return {
      client, status: 'failed', reason: result.timedOut ? 'timeout' : result.spawnCode ?? 'client_failed',
      exitCode: result.code, stdoutDigest: digest(result.stdout), stderrDigest: digest(result.stderr),
    };
  }

  const { openConnection } = await import('../dist/db/connection.js');
  const database = openConnection(databasePath, { readOnly: true });
  try {
    const run = database.prepare(`
      SELECT ec.run_id AS runId, ec.status, ec.contract_json AS contractJson
      FROM enno_contracts AS ec JOIN ledger_runs AS lr ON lr.run_id = ec.run_id
      WHERE lr.client_kind = ? ORDER BY ec.created_at DESC LIMIT 1
    `).get(client);
    if (run?.status !== 'completed') return { client, status: 'failed', reason: 'enno_run_not_completed' };
    const events = database.prepare(`
      SELECT event_type AS eventType FROM ledger_events WHERE run_id = ?
      AND (event_type LIKE 'enno.%' OR event_type LIKE 'zenki.%' OR event_type LIKE 'goki.%')
      ORDER BY sequence
    `).all(run.runId).map((row) => row.eventType);
    const required = ['enno.started', 'zenki.plan_created', 'enno.plan_confirmed', 'goki.work_started', 'goki.work_completed', 'enno.verification_started', 'enno.verification_passed', 'enno.completed'];
    let cursor = 0;
    for (const event of events) if (event === required[cursor]) cursor += 1;
    if (cursor !== required.length) return { client, status: 'failed', reason: 'ledger_role_sequence_incomplete', events };
    const loops = events.filter((event) => event === 'goki.work_started').length;
    if (loops > 3) return { client, status: 'failed', reason: 'loop_limit_exceeded', loops };
    const contract = JSON.parse(run.contractJson);
    const skillSnapshotPresent = Array.isArray(contract?.skillSet?.entries) && contract.skillSet.entries.length > 0;
    const workCompleted = database.prepare("SELECT COUNT(*) AS count FROM enno_work_units WHERE run_id = ? AND status = 'completed'").get(run.runId)?.count > 0;
    const freshEvidence = database.prepare("SELECT COUNT(*) AS count FROM enno_verifier_runs WHERE run_id = ? AND status = 'passed'").get(run.runId)?.count > 0;
    if (!skillSnapshotPresent || !workCompleted || !freshEvidence) {
      return { client, status: 'failed', reason: 'required_run_evidence_missing' };
    }
    return { client, status: 'passed', loops, ...(codexChecks === undefined ? {} : { codexChecks }) };
  } finally {
    database.close();
  }
}

const results = [];
for (const client of clients) results.push(await runClient(client));
process.stdout.write(`${JSON.stringify({ protocolVersion: 1, results })}\n`);
if (results.some((result) => result.status === 'failed')) process.exitCode = 1;
