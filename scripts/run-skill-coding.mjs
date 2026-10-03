import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateConfig } from './skill-coding/contracts.mjs';
import { runProcess } from './skill-coding/docker.mjs';
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--config' || args[2] !== '--output') {
    console.error('Usage: npm run test:skill-coding -- --config file --output new-directory');
    process.exitCode = 2;
}
else {
    try {
        const config = validateConfig(JSON.parse(await readFile(args[1], 'utf8')));
        for (const m of [config.candidate, config.reviewer])
            if (!process.env[m.apiKeyEnv])
                throw new Error('credential_unavailable');
        const image = await runProcess('docker', ['image', 'inspect', config.image]);
        if (image.code !== 0)
            throw new Error('image_unavailable');
        const { evaluate } = await import('./skill-coding/evaluate.mjs');
        const controller = new AbortController();
        const interrupt = () => controller.abort();
        process.once('SIGINT', interrupt);process.once('SIGTERM', interrupt);
        let report;
        try {report = await evaluate(config, resolve(args[3]),controller.signal)}finally{process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt)}
        console.log(JSON.stringify({ status: report.status, records: report.records.length, eligibleForDefault: false }));
        if (report.status !== 'measured' || report.records.some(r => r.mode !== 'baseline-full' && r.status !== 'passed'))
            process.exitCode = 1;
    }
    catch {
        console.error(JSON.stringify({ status: 'unmeasured', reason: 'Configuration, credential, built runtime or Docker prerequisite unavailable; no success claimed.' }));
        process.exitCode = 2;
    }
}
