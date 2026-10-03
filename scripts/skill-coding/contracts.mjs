import { createHash } from 'node:crypto';
import { z } from 'zod';
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const model = z.object({ provider: z.string().regex(/^[a-z][a-z0-9-]+$/), model: z.string().min(1), revision: z.string().min(1), api: z.string().min(1), baseURL: z.string().url(), apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/), contextWindow: z.number().int().positive(), maxOutputTokens: z.number().int().positive() }).strict();
export const configSchema = z.object({ candidate: model, reviewer: model, allowRemote: z.boolean(), image: z.string().regex(/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/), maxRequests: z.number().int().positive(), maxTokens: z.number().int().positive(), maxDurationMs: z.number().int().min(1000), maxToolCalls: z.number().int().positive() }).strict();
export function validateConfig(input) {
    const config = configSchema.parse(input);
    for (const model of [config.candidate, config.reviewer]) {
        const url = new URL(model.baseURL);
        if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol))
            throw new Error('invalid_endpoint');
        if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && (!config.allowRemote || url.protocol !== 'https:'))
            throw new Error('remote_not_authorized');
    }
    return config;
}
export class Budget {
    requests = 0;
    reservedTokens = 0;
    toolCalls = 0;
    usage = [];
    constructor(config) { this.config = config; this.deadline = Date.now() + config.maxDurationMs; }
    check() { if (Date.now() >= this.deadline)
        throw new Error('budget_exhausted'); }
    request(model) { this.check(); const reserve = model.contextWindow + model.maxOutputTokens; if (this.requests >= this.config.maxRequests || this.reservedTokens + reserve > this.config.maxTokens)
        throw new Error('budget_exhausted'); this.requests++; this.reservedTokens += reserve; }
    tool() { this.check(); if (++this.toolCalls > this.config.maxToolCalls)
        throw new Error('budget_exhausted'); }
}
export function pairedSchedule(cases) {
    const modes = ['baseline-full', 'candidate-full', 'candidate-compiled'];
    return cases.flatMap(fixture => Array.from({ length: 3 }, (_, repeat) => modes.map((_, i) => ({ fixture, repeat, mode: modes[(i + repeat) % 3] }))).flat());
}
export function judgeClaims(claims, ledger) {
    return claims.every(claim => !['executed', 'blocked'].includes(claim.status) || ledger.some(e => e.check === claim.check && e.status === (claim.status === 'executed' ? 'passed' : 'blocked') && e.digest === claim.digest));
}

export function compareRecords(records) {
    const modes = ['baseline-full', 'candidate-full', 'candidate-compiled'];
    const summary = Object.fromEntries(modes.map(mode => {
        const selected = records.filter(record => record.mode === mode);
        return [mode, { runs: selected.length, passed: selected.filter(record => record.status === 'passed').length,
            findings: selected.reduce((count, record) => count + (record.review?.findings.length ?? 0), 0) }];
    }));
    const regressions = records.filter(record => record.mode !== 'baseline-full' && record.status !== 'passed'
        && records.some(base => base.mode === 'baseline-full' && base.case === record.case && base.repeat === record.repeat && base.status === 'passed'))
        .map(record => ({case: record.case, repeat: record.repeat, mode: record.mode}));
    return { summary, regressions, interpretation: 'Fixture observations only; reviewer findings are model judgments, not statistical proof.' };
}
