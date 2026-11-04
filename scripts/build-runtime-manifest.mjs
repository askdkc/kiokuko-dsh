import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..'), dist = join(root, 'dist')
const files = []
function visit(directory) {
  for (const entry of readdirSync(join(dist, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = join(directory, entry.name)
    if (entry.isDirectory()) visit(name)
    else if (entry.isFile() && name !== 'build-info.json') files.push([name, createHash('sha256').update(readFileSync(join(dist, name))).digest('hex')])
  }
}
visit('')
const { version: packageVersion } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
let sourceCommit = null
try { sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { /* Registry build can omit Git. */ }
const buildId = createHash('sha256').update(JSON.stringify({ packageVersion, files })).digest('hex')
writeFileSync(join(dist, 'build-info.json'), JSON.stringify({ schema: 'kiokuko.build.v1', packageVersion, buildId, sourceCommit, builtAt: new Date().toISOString(), fileCount: files.length }, null, 2) + '\n')
