import { main } from './repair-continuation-source.mjs'

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
