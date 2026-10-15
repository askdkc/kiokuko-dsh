import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { detectRepositoryRoot } from '../../../src/repository/detect-root.js'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'

const repository = path.resolve(import.meta.dirname, '../../..')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
for (const script of ['run-memory-reuse-evaluation.mjs', 'run-evolution-evaluation.mjs', 'run-selection-state-benchmark.mjs']) {
  for (const placement of ['direct-parent', 'nested-temp']) test(`${script} owns a real Git root: ${placement}`, async t => {
    const controlled = realpathSync(await mkdtemp(join(tmpdir(), 'evaluation-git-contract-')))
    const parent = join(controlled, 'parent'), nested = placement === 'direct-parent' ? parent : join(parent, 'temporary')
    const previous = { ...process.env }
    try {
      await mkdir(nested, { recursive: true }); await mkdir(join(controlled, 'home'))
      for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key]
      Object.assign(process.env, { HOME: join(controlled, 'home'), TMPDIR: nested, TMP: nested, TEMP: nested,
        GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' })
      execFileSync('git', ['init', '--quiet', '--template=', parent])
      assert.equal(realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: nested, encoding: 'utf8' }).trim()), parent)
      const source = await readFile(join(repository, 'scripts', script), 'utf8')
      const starts = script === 'run-memory-reuse-evaluation.mjs' ? '    const root = await mkdtemp(' : script === 'run-evolution-evaluation.mjs' ? 'const root=await mkdtemp(' : '    const location = join(root,String(size));'
      const ends = script === 'run-memory-reuse-evaluation.mjs' ? '      const project =' : script === 'run-evolution-evaluation.mjs' ? 'const counters=' : '    const db = openConnection('
      const begin = source.indexOf(starts), end = source.indexOf(ends, begin)
      if (begin < 0 || end <= begin || source.indexOf(starts, begin + 1) !== -1) throw new Error('Evaluation fixture setup boundary changed')
      let setup = source.slice(begin, end)
      setup += script === 'run-memory-reuse-evaluation.mjs' ? '\nreturn root\n} finally { db.close() }' : script === 'run-evolution-evaluation.mjs' ? '\nreturn root' : '\nreturn location'
      let initializeEvaluationRepository
      if (source.includes("import { initializeEvaluationRepository } from './evaluation-git-fixture.mjs'")) {
        ;({ initializeEvaluationRepository } = await import(pathToFileURL(join(repository, 'scripts/evaluation-git-fixture.mjs')).href))
      }
      const create = new AsyncFunction('mkdtemp', 'tmpdir', 'join', 'path', 'mkdir', 'openConnection', 'migrateDatabase', 'initializeEvaluationRepository', script === 'run-selection-state-benchmark.mjs' ? 'root' : 'unusedRoot', 'size', setup)
      const location = realpathSync(await create(mkdtemp, tmpdir, join, path, mkdir, openConnection, migrateDatabase, initializeEvaluationRepository, nested, 20))
      const detected = detectRepositoryRoot({ cwd: location, allowDirectory: true })
      t.diagnostic(JSON.stringify({ script, placement, location, detected }))
      assert.equal(detected.root, location, 'The actual evaluation setup must not inherit its parent repository')
      assert.equal(detected.source, 'git', 'An empty .git marker is insufficient for an evaluation repository')
      assert.notEqual(location, parent)
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
      Object.assign(process.env, previous)
      await rm(controlled, { recursive: true, force: true })
    }
  })
}
