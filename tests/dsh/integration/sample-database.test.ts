import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, '../../..')

test('committed sample database upgrades through current migrations and resumes its DSH run', { timeout: 60_000 }, async () => {
  // Run the same verifier as CI so npm test also detects upgrade regressions.
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  await execFileAsync(process.execPath, ['--import', 'tsx', 'tests/ci/verify-sample-database.ts'], {
    cwd: repositoryRoot,
    env,
    timeout: 55_000,
    maxBuffer: 1024 * 1024,
  })
})
