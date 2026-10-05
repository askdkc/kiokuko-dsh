import { parseArgs } from 'node:util'
import { readFile, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { parseEvaluationConfig } from './skill-evaluation-config.mjs'

try {
  const { values } = parseArgs({ options: { offline: { type: 'boolean' }, config: { type: 'string' }, output: { type: 'string' } } })
  if (values.offline && values.config || values.config === '' || values.output === '') throw new Error('invalid_arguments')
  if (!values.offline && !values.config) {
    console.log(JSON.stringify({ status: 'unmeasured', modelRequests: 0, reason: 'Use --offline for local connectivity or --config and --output for explicitly budgeted live evaluation.' }))
  } else {
    const config = values.config ? parseEvaluationConfig(JSON.parse(await readFile(values.config, 'utf8'))) : undefined
    delete process.env.NODE_TEST_CONTEXT
    const { runPrototypeEvaluation } = await import('./lisp-prototype-evaluation.mjs')
    const output = values.output ? resolve(values.output) : await mkdtemp(join(tmpdir(), 'lisp-prototype-results-'))
    const report = await runPrototypeEvaluation({ config, output, ...(process.env.KIOKUKO_DSH_PACKAGE_ROOT ? { packages: process.env.KIOKUKO_DSH_PACKAGE_ROOT } : {}) })
    console.log(JSON.stringify({ status: report.status, tasks: report.records.length, modelRequests: report.modelRequests, modelQuality: report.modelQuality, report: join(output, 'report.json') }))
    if (report.status !== 'passed' && report.status !== 'needs_review') process.exitCode = 1
  }
} catch {
  console.error('Lisp prototype evaluation failed. Check arguments, explicit configuration, runtime prerequisites and the partial report. No automatic retry was made.')
  process.exitCode = 1
}
