import { loadStandardSkillParity } from '../dist/dsh/standard-skill-integrity.js'

const parity = await loadStandardSkillParity()
if (parity.skills.length !== 6 || parity.markdownFileCount !== 21 || parity.referenceFileCount !== 15) {
  throw new Error('dsh Skill parity counts are invalid')
}
process.stdout.write(JSON.stringify({
  skills: parity.skills,
  markdownFileCount: parity.markdownFileCount,
  referenceFileCount: parity.referenceFileCount,
  contentDigest: parity.contentDigest,
}) + '\n')
