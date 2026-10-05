import { spawn } from 'node:child_process';

interface BackupWorkerInput {
  readonly directory: string;
  readonly script: string;
  readonly request: string;
  readonly bytes: Buffer;
  readonly deadlineMs: number;
  readonly outputLimitBytes: number;
}

/** Run the trusted backup script without blocking the parent's event loop; settle only after child close. */
export function runBackupWorker(input: BackupWorkerInput): Promise<Buffer> {
  const child = spawn(process.execPath, ['--input-type=commonjs', '--eval', input.script, input.request], {
    cwd: input.directory,
    env: {},
    shell: false,
    stdio: 'pipe',
  });
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let failure: Error | undefined;
    const fail = (error: Error): void => {
      if (failure !== undefined) return;
      failure = error;
      child.kill('SIGKILL');
    };
    const deadline = setTimeout(() => fail(Object.assign(new Error('Bound backup writer timed out'), {
      code: 'ETIMEDOUT',
    })), input.deadlineMs);
    const collect = (chunk: Buffer, stdout: boolean): void => {
      if (failure !== undefined) return;
      outputBytes += chunk.length;
      if (outputBytes > input.outputLimitBytes) {
        fail(Object.assign(new Error('Bound backup writer exceeded its output limit'), { code: 'ENOBUFS' }));
      } else if (stdout) chunks.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, true));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, false));
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.on('close', (status, signal) => {
      clearTimeout(deadline);
      if (failure !== undefined) reject(failure);
      else if (status !== 0 || signal !== null) reject(new Error('Bound backup writer subprocess failed'));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input.bytes);
  });
}
