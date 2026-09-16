import { probeLispP0 } from './lisp-p0/probe.js'
import { formatP0Report } from './lisp-p0/report.js'

const args = process.argv.slice(2)
if (args.some(arg => arg !== '--json') || args.length > 1) {
  console.error('Usage: npm run probe:lisp:p0 -- [--json]')
  process.exitCode = 64
} else {
  try {
    const report = await probeLispP0()
    console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatP0Report(report))
    process.exitCode = 2 // Deliberately blocked until all P0 requirements have actual proof.
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
