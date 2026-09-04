import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(join(tmpdir(), 'kiokuko-kgp-'))
try {
  const generatedTs = join(temporary, 'kgp-dispatch.ts')
  const generatedVectors = join(temporary, 'kgp-vectors.json')
  const result = await execFileAsync('sbcl', [
    '--script', 'kgp/reference.lisp', '--generate', generatedTs, generatedVectors,
  ], { cwd: root, maxBuffer: 1024 * 1024 * 8 })
  assert.match(result.stdout, /66\/66 passed/u)
  assert.equal(await readFile(generatedTs, 'utf8'), await readFile(join(root, 'src/dsh/generated/kgp-dispatch.ts'), 'utf8'))
  assert.equal(await readFile(generatedVectors, 'utf8'), await readFile(join(root, 'tests/fixtures/kgp-vectors.json'), 'utf8'))
  const valid = await readFile(join(root, 'kgp/orchestration.kgp'), 'utf8')
  const invalid = [
    ['multiple-effects', valid.replace('(:pure) process-state)', '(:pure :outbox) process-state)'), /multiple effects/u],
    ['nonterminal-complete', valid.replace('"classified" (:pure)', '"complete" (:pure)'), /Non-terminal state/u],
    ['ambiguous-method', valid.replace(
      '(next-action applied-state "advance" (:pure) applied-state)',
      '(next-action applied-state "advance" (:pure) applied-state)\n     (next-action applied-state "advance-again" (:pure) applied-state)',
    ), /Ambiguous duplicate method/u],
  ]
  for (const [name, source, expected] of invalid) {
    const path = join(temporary, `${name}.kgp`)
    await writeFile(path, source)
    await assert.rejects(
      execFileAsync('sbcl', ['--script', 'kgp/reference.lisp', '--spec', path], { cwd: root }),
      error => expected.test(String(error.stderr)),
      name,
    )
  }
  process.stdout.write(result.stdout)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
