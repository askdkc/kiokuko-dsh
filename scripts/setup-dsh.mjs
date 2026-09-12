import { parseArgs } from 'node:util'
import { setupDsh } from '../dist/dsh/setup.js'

try {
  const { values } = parseArgs({ options: {
    cwd: { type: 'string' }, home: { type: 'string' },
    check: { type: 'boolean', default: false }, json: { type: 'boolean', default: false },
  } })
  const result = await setupDsh({ cwd: values.cwd, homeDirectory: values.home, check: values.check })
  if (values.json) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(values.check ? result.current ? 'Setup is current.' : 'Setup needs updating; run again without --check.' : 'Setup complete. Reload existing sessions to refresh their instructions.')
    console.log(`Skills: ${result.skills.directory} (${result.skills.created} ${values.check ? 'missing' : 'created'}, ${result.skills.updated} ${values.check ? 'stale' : 'updated'}, ${result.skills.unchanged} unchanged)`)
    console.log(`Project instructions: ${result.instructions.path} (${result.instructions.status})`)
  }
  if (!result.current) process.exitCode = 1
} catch (error) {
  console.error(`Setup failed: ${error.message}`)
  process.exitCode = 1
}
