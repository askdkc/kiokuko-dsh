// Host-owned reporter. Test stdout is diagnostic data and cannot issue receipts.
import { run } from 'node:test'
import { tap } from 'node:test/reporters'
import { writeSync } from 'node:fs'
import path from 'node:path'
const input = JSON.parse(process.argv[2])
if (!Array.isArray(input.files) || !input.files.length || input.files.length > 32 || input.files.some(file => typeof file !== 'string' || !path.isAbsolute(file))) throw Error('Invalid selected test files')
const observation = { schema: 1, operationId: input.operationId, runtimeDigest: input.runtimeDigest, environmentDigest: input.environmentDigest, complete: false, tests: 0, passed: 0, failed: 0, assertionFailures: 0, otherFailures: 0, skipped: 0, todo: 0, cancelled: 0, explicit: 0 }
const files = new Set(input.files.map(file => path.resolve(file)))
let summaries = 0, finalSummary
const stream = run({ files: input.files, isolation: 'process', concurrency: false, timeout: input.timeoutMs })
stream.on('data', event => {
  const d = event.data
  if (event.type === 'test:summary' && d.file === undefined) { summaries++; finalSummary = d }
  if (!['test:pass', 'test:fail'].includes(event.type) || d.details?.type === 'suite') return
  if (!files.has(path.resolve(d.file ?? ''))) { observation.otherFailures++; return }
  observation.tests++
  const fileOnly = d.line === 1 && d.column === 1 && [d.file, path.relative(process.cwd(), d.file), path.basename(d.file)].includes(d.name)
  if (!fileOnly) observation.explicit++
  if (d.skip) observation.skipped++
  else if (d.todo) observation.todo++
  else if (event.type === 'test:pass') observation.passed++
  else {
    observation.failed++
    const error = d.details?.error, cause = error?.cause ?? error
    // Node serializes errors across the isolated test process. These fields reject renamed ordinary
    // Errors, but model-written tests can fabricate assertion semantics; this is not attestation.
    if (!fileOnly && cause?.code === 'ERR_ASSERTION' && cause?.name === 'AssertionError' && typeof cause.operator === 'string' && cause.operator.length > 0 && typeof cause.generatedMessage === 'boolean' && Object.hasOwn(cause,'actual') && Object.hasOwn(cause,'expected')) observation.assertionFailures++
    else { observation.otherFailures++; if (error?.failureType === 'cancelledByParent' || error?.failureType === 'testTimeoutFailure') observation.cancelled++ }
  }
})
stream.compose(tap).pipe(process.stdout)
stream.on('end', () => {
  observation.complete = summaries === 1 && finalSummary?.counts?.tests === observation.tests && observation.tests > 0
  writeSync(3, JSON.stringify(observation) + '\n')
  process.exitCode = observation.failed || observation.otherFailures || observation.cancelled ? 1 : 0
})
