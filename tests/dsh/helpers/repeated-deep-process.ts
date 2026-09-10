import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { repeatedDeepHost, completeDeepRound } from './repeated-deep-native.js'
const [root, number] = process.argv.slice(2)
if (!root || !number) throw new Error('Deep lifecycle process requires its root and round')
const round = Number(number), f = await repeatedDeepHost(root, [round], `deep-process-${round}`)
try { await writeFile(join(root, '.git', `deep-round-${round}.json`), JSON.stringify(await completeDeepRound(f, round))) }
finally { await f.close() }
