import { realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readRegularFile } from '../config/read-regular-file.js'
import { KiokukoError } from '../errors.js'
import { loadStandardSkillParity } from './standard-skill-integrity.js'
import { renderStandardSkillFile } from './standard-skills.js'
import { JAPANESE_OUTPUT_SKILL_DIRECTORY, JAPANESE_OUTPUT_SKILL_MANAGED_MARKER, loadJapaneseOutputSkill } from './japanese-output-skill.js'
import { deploymentParent, publishFile, type DeploymentFile } from './managed-file-deployment.js'

export interface StandardSkillDeployment {
  readonly directory: string
  readonly created: number
  readonly updated: number
  readonly unchanged: number
}

/** Preflight all seven standard Skills plus Japanese output without writing files. */
export async function planStandardSkills(homeDirectory: string = os.homedir()): Promise<{ home: string; directory: string; files: DeploymentFile[] }> {
  if (!path.isAbsolute(homeDirectory) || homeDirectory.includes('\0') || path.resolve(homeDirectory) === path.parse(homeDirectory).root) {
    throw new KiokukoError('VALIDATION_ERROR', 'Standard Skill deployment requires an absolute user home')
  }
  const home = await realpath(homeDirectory)
  const directory = path.join(home, '.agents', 'skills')
  const parity = await loadStandardSkillParity()
  const japanese = await loadJapaneseOutputSkill()
  const bundledFiles = [
    ...parity.files.map(file => ({ ...file, directoryName: file.skillName })),
    { skillName: japanese.name, directoryName: JAPANESE_OUTPUT_SKILL_DIRECTORY,
      managedMarker: JAPANESE_OUTPUT_SKILL_MANAGED_MARKER, relativePath: 'SKILL.md', content: japanese.content },
  ]
  const files: DeploymentFile[] = []
  // Preflight the complete manifest before creating or replacing any deployed file.
  for (const bundled of bundledFiles) {
    const target = path.join(directory, bundled.directoryName, bundled.relativePath)
    await deploymentParent(home, target, false)
    const previous = await readRegularFile(target, { containmentRoot: home })
    const rendered = renderStandardSkillFile(previous?.content, bundled, target)
    files.push({ target, content: rendered.content, previous })
  }
  return { home, directory, files }
}

export async function synchronizeStandardSkills(homeDirectory: string = os.homedir()): Promise<StandardSkillDeployment> {
  const { home, directory, files } = await planStandardSkills(homeDirectory)
  const result = { directory, created: 0, updated: 0, unchanged: 0 }
  for (const file of files) {
    if (file.previous?.content === file.content) result.unchanged++
    else result[await publishFile(home, file)]++
  }
  // Atomicity is per file. An interrupted tree is completed on the next plugin load.
  return result
}
