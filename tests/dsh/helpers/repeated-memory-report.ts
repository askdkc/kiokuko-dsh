import { AsyncLocalStorage } from 'node:async_hooks'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const stages = new AsyncLocalStorage<unknown[]>()
export function recordRepeatedStage(value: unknown): void { stages.getStore()?.push(value) }

/** Only explicit fixture state is recorded; never serialize provider requests or errors. */
export async function withRepeatedReport(name: string, operation: () => Promise<void>): Promise<void> {
  const observations: unknown[] = []
  let status = 'failed'
  try { await stages.run(observations, operation); status = 'passed' }
  finally {
    const directory = process.env.KIOKUKO_REPEATED_REPORT_DIR
    if (directory) {
      await mkdir(directory, { recursive: true })
      const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT!
      const sourceFiles = ['tests/dsh/helpers/repeated-memory-native.ts', 'tests/dsh/helpers/repeated-deep-native.ts', 'tests/dsh/helpers/repeated-interruption-process.ts', 'tests/dsh/e2e/repeated-memory-lifecycle.test.ts']
      const digest = createHash('sha256')
      for (const path of sourceFiles) digest.update(path).update(await readFile(path))
      const report = { version: 2, scenario: name, status, observations,
        expected: { lifecycleRounds: 3, subsequentLessonProbe: name.startsWith('deep/') ? 'dedicated Deep finalization contract' : 'normal series plus correction/duplicate/retry cases', stageTimeoutMs: 60000, seriesTimeoutMs: 300000 },
        actual: { allAssertionsPassed: status === 'passed' }, skipped: 0, failureReason: status === 'passed' ? null : 'stage_or_assertion_failed',
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        workingTreeClean: !execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), nodeVersion: process.version,
        dshVersion: JSON.parse(await readFile(join(packages, '@deepseek-ai/dsh/package.json'), 'utf8')).version,
        fixtureDigest: digest.digest('hex'), settings: { route: name.split('/')[0], inputMode: name.split('/')[1] }, realModelQuality: 'unmeasured' }
      await writeFile(join(directory, `${name.replaceAll('/', '-')}.json`), JSON.stringify(report, null, 2) + '\n')
    }
  }
}
