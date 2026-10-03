import { chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
export function runProcess(executable, args, { timeoutMs = 10000, maxBytes = 131072, signal } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH }, signal });
        let output = '', overflow = false;
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        for (const stream of [child.stdout, child.stderr])
            stream.on('data', chunk => { output += chunk.toString(); if (Buffer.byteLength(output) > maxBytes) {
                overflow = true;
                output = output.slice(0, maxBytes);
                child.kill('SIGKILL');
            } });
        child.once('error', e => { clearTimeout(timer); reject(e); });
        child.once('close', (code, termination) => { clearTimeout(timer); resolve({ code, termination, output, overflow }); });
    });
}
export function dockerArgs(image, root, oracle, name) {
    return ['run', '--pull=never', '--name', name, '--rm', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=256m', '--cpus=1', '--user=65534:65534', '--tmpfs=/tmp:rw,noexec,nosuid,size=16m', '--mount', `type=bind,src=${root},dst=/work,readonly`, '--mount', `type=bind,src=${oracle},dst=/oracle,readonly`, '--workdir=/work', image, 'node', '/oracle/check.mjs'];
}
export async function verifyInDocker(image, root, oracle, signal) {
    await chmod(root, 0o755);
    await chmod(oracle, 0o755);
    const name = 'kiokuko-skill-' + randomUUID();
    try {
        const result = await runProcess('docker', dockerArgs(image, root, oracle, name), { timeoutMs: 15000, signal });
        return { status: result.code === 0 && !result.overflow ? 'passed' : 'failed', ...result };
    }
    finally {
        await runProcess('docker', ['rm', '-f', name]).catch(() => { });
    }
}
