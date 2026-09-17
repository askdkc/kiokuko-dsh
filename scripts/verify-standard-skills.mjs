import { loadStandardSkillParity } from '../dist/dsh/standard-skill-integrity.js'

const parity = await loadStandardSkillParity()
if (parity.skills.length !== 8 || parity.markdownFileCount !== 27 || parity.referenceFileCount !== 19) {
  throw new Error('dsh Skill parity counts are invalid')
}
process.stdout.write(JSON.stringify({
  skills: parity.skills,
  markdownFileCount: parity.markdownFileCount,
  referenceFileCount: parity.referenceFileCount,
  contentDigest: parity.contentDigest,
}) + '\n')
