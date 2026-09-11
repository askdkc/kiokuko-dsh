import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_FILE_SUFFIX = '.test.ts';

async function collectDirectoryTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedTests = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectDirectoryTests(entryPath);
      }
      return entry.isFile() && entry.name.endsWith(TEST_FILE_SUFFIX) ? [entryPath] : [];
    }),
  );
  return nestedTests.flat();
}

async function collectTargetTests(target) {
  const targetStats = await stat(target);
  if (targetStats.isDirectory()) {
    return collectDirectoryTests(target);
  }
  if (targetStats.isFile() && target.endsWith(TEST_FILE_SUFFIX)) {
    return [target];
  }
  throw new Error(`Test target must be a directory or ${TEST_FILE_SUFFIX} file: ${target}`);
}

async function collectTestFiles(targets) {
  const testFiles = (await Promise.all(targets.map(collectTargetTests))).flat();
  testFiles.sort();
  if (testFiles.length === 0) {
    throw new Error(`No ${TEST_FILE_SUFFIX} files found in: ${targets.join(', ')}`);
  }
  return testFiles;
}

function runNodeTests(testFiles, testTempRoot) {
  return new Promise((resolve, reject) => {
    const childEnvironment = {
      ...process.env,
      TEMP: testTempRoot,
      TMP: testTempRoot,
      TMPDIR: testTempRoot,
    };
    delete childEnvironment.NODE_TEST_CONTEXT;

    const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...testFiles], {
      cwd: process.cwd(),
      env: childEnvironment,
      stdio: 'inherit',
      // A timed-out series must also stop its native fixture subprocesses.
      detached: process.platform !== 'win32',
    });
    let killTimer;
    const stopGroup = (signal) => {
      try {
        if (process.platform === 'win32') child.kill(signal);
        else if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const interrupt = () => {
      stopGroup('SIGTERM');
      killTimer ??= setTimeout(() => stopGroup('SIGKILL'), 5_000);
    };
    const cleanup = () => {
      clearTimeout(killTimer);
      process.off('SIGTERM', interrupt); process.off('SIGINT', interrupt);
    };
    process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt);
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => {
      // A descendant may outlive the test runner even when its direct child
      // has exited. Kill only the dedicated fixture process group.
      if (process.platform !== 'win32' || killTimer !== undefined) stopGroup('SIGKILL');
      cleanup();
      if (signal !== null) {
        reject(new Error(`Test process terminated by ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function run() {
  const targets = process.argv.length > 2 ? process.argv.slice(2) : ['tests'];
  const testFiles = await collectTestFiles(targets);
  const testTempRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-test-run-'));

  try {
    return await runNodeTests(testFiles, testTempRoot);
  } finally {
    await rm(testTempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

try {
  process.exitCode = await run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
