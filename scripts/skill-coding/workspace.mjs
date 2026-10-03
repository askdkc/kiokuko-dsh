import { readFile, writeFile, mkdir, readdir, lstat } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { digest } from './contracts.mjs';
export async function safePath(root, name) {
    if (typeof name !== 'string' || !name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || name.split('/').some(p => p === '..' || p === '.git'))
        throw new Error('outside_workspace');
    const path = resolve(root, name);
    if (!relative(root, path) || relative(root, path).startsWith('..'))
        throw new Error('outside_workspace');
    let cursor = root;
    for (const part of relative(root, path).split('/')) {
        cursor = resolve(cursor, part);
        try {
            if ((await lstat(cursor)).isSymbolicLink())
                throw new Error('symlink_rejected');
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
        }
    }
    return path;
}
export async function snapshot(root) {
    const files = {};
    let bytes = 0;
    async function visit(dir, prefix = '') {
        for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const name = prefix + entry.name;
            const path = await safePath(root, name);
            if (entry.isDirectory())
                await visit(path, name + '/');
            else if (entry.isFile()) {
                const value = await readFile(path);
                bytes += value.length;
                if (bytes > 262144 || Object.keys(files).length >= 64)
                    throw new Error('workspace_limit');
                files[name] = value.toString('utf8');
            }
            else
                throw new Error('unsupported_file');
        }
    }
    await visit(root);
    return { files, digest: digest(files) };
}
export async function put(root, name, content) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > 65536)
        throw new Error('file_limit');
    const path = await safePath(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { flag: 'w' });
}
export const diff = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter(p => before[p] !== after[p]).map(path => ({ path, before: before[path] ?? null, after: after[path] ?? null }));
