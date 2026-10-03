import { loadStandardSkillParity } from '../dist/dsh/standard-skill-integrity.js'

const parity = await loadStandardSkillParity()
process.stdout.write(JSON.stringify({
  skills: parity.skills,
  markdownFileCount: parity.markdownFileCount,
  referenceFileCount: parity.referenceFileCount,
  contentDigest: parity.contentDigest,
}) + '\n')
