import { readFile } from 'node:fs/promises';
import { snapshot, put, safePath } from './workspace.mjs';

function definition(name, parameters, execute) {
    return {
        name, description: name, parameters,
        output: {schema: {type: 'object'}, render: (_args, result) => [{type: 'text', text: JSON.stringify(result)}]},
        execute: async args => ({value: await execute(args)}),
    };
}

/** The model receives only these fixture capabilities, never a shell or host filesystem. */
export function fixtureTools({work, resources, budget, checks, submit}) {
    async function files() {
        budget.tool();
        return Object.keys((await snapshot(work)).files);
    }
    async function search({query}) {
        budget.tool();
        if (typeof query !== 'string' || !query || query.length > 256) throw new Error('query_limit');
        const hits = [];
        for (const [path, text] of Object.entries((await snapshot(work)).files)) {
            for (const [index, line] of text.split('\n').entries()) {
                if (line.includes(query)) hits.push({path, line: index + 1, text: line});
                if (hits.length === 40) return hits;
            }
        }
        return hits;
    }
    async function read({path}) {
        budget.tool();
        return readFile(await safePath(work, path), 'utf8');
    }
    async function write({path, content}) {
        budget.tool();
        if (typeof path !== 'string' || !/^[a-zA-Z0-9_/-]+\.mjs$/.test(path)) throw new Error('file_type_rejected');
        await put(work, path, content);
        return snapshot(work);
    }
    async function reference({name}) {
        budget.tool();
        const source = resources.find(s => `${s.name}/${s.relativePath}` === name);
        if (!source) throw new Error('unknown_reference');
        return source.content;
    }
    async function verify({check}) {
        if (!['local', 'external'].includes(check)) throw new Error('unknown_check');
        return checks(check);
    }
    async function report(args) {
        budget.tool();
        submit(args);
        return {received: true};
    }
    const string = {type: 'string', required: true};
    return [
        definition('files', {}, files),
        definition('search', {query: string}, search),
        definition('read', {path: string}, read),
        definition('write', {path: string, content: string}, write),
        definition('skill_reference', {name: string}, reference),
        definition('verify', {check: {...string, enum: ['local', 'external']}}, verify),
        definition('report', {claims: {type: 'array', required: true, items: {
            type: 'object', additionalProperties: false, required: ['check', 'status', 'digest'],
            properties: {check: {type: 'string', enum: ['local', 'external']},
                status: {type: 'string', enum: ['executed', 'blocked', 'source-inspected', 'unverified']}, digest: {type: 'string'}},
        }}}, report),
    ];
}
