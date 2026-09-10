import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { repeatedNativeHost, deadline, type RepeatedRoute } from './repeated-memory-native.js'
import type { FinalizationInputMode } from '../../../src/dsh/efficiency.js'

const [root, mode, route, value] = process.argv.slice(2)
if (!root || !['prefix_reuse','bounded_evidence'].includes(mode!) || !['normal','enno'].includes(route!)) throw new Error('Invalid lifecycle process arguments')
const round = Number(value)
const host = await repeatedNativeHost(root, mode as FinalizationInputMode, route as RepeatedRoute)
try {
  const report = await deadline(host.round(round, `process-session-${round}`, round === 4), `process round ${round}`)
  await writeFile(join(root, '.git', `round-${round}.json`), JSON.stringify(report))
} finally { await host.close() }
