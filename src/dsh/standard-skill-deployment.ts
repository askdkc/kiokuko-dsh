import { readdir, realpath, rmdir, unlink } from 'node:fs/promises'
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

export interface StandardSkillRetirement {
  readonly directory: string
  readonly removed: number
  readonly preserved: number
}

/** Preflight all standard Skills plus Japanese output without writing files. */
export async function planStandardSkills(homeDirectory: string = os.homedir(), options: { preserveUnmanaged?: boolean } = {}): Promise<{ home: string; directory: string; files: DeploymentFile[] }> {
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
    const content = options.preserveUnmanaged ? bundled.content : renderStandardSkillFile(previous?.content, bundled, target).content
    files.push({ target, content, previous })
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

async function countUnplannedEntries(directory: string, planned: ReadonlySet<string>): Promise<number> {
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  let count = 0
  for (const entry of entries) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) count += await countUnplannedEntries(target, planned)
    else if (!planned.has(target)) count++
  }
  return count
}

async function removeEmptyDeploymentDirectories(directory: string, files: readonly DeploymentFile[]): Promise<void> {
  const directories = new Set<string>()
  for (const file of files) {
    let current = path.dirname(file.target)
    while (current !== directory && current.startsWith(`${directory}${path.sep}`)) {
      directories.add(current)
      current = path.dirname(current)
    }
  }
  for (const target of [...directories].sort((left, right) => right.length - left.length)) {
    try { await rmdir(target) } catch { /* Preserve non-empty, absent, or otherwise unavailable directories. */ }
  }
}

/** Remove only deployed files that still match this package byte-for-byte. */
export async function retireStandardSkills(homeDirectory: string = os.homedir(), options: { check?: boolean } = {}): Promise<StandardSkillRetirement> {
  const { home, directory, files } = await planStandardSkills(homeDirectory, { preserveUnmanaged: true })
  const planned = new Set(files.map(file => file.target))
  const result = { directory, removed: 0, preserved: await countUnplannedEntries(directory, planned) }
  for (const file of files) {
    if (file.previous === undefined) continue
    if (file.previous.content !== file.content) {
      result.preserved++
      continue
    }
    if (options.check) {
      result.removed++
      continue
    }
    const current = await readRegularFile(file.target, { containmentRoot: home })
    if (current === undefined) continue
    if (current.content !== file.content) {
      result.preserved++
      continue
    }
    try {
      await unlink(file.target)
      result.removed++
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (!options.check) await removeEmptyDeploymentDirectories(directory, files)
  return result
}
