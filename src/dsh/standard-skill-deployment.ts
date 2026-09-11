import { link, lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readRegularFile, type RegularFileSnapshot } from '../config/read-regular-file.js'
import { KiokukoError } from '../errors.js'
import { loadStandardSkillParity } from './standard-skill-integrity.js'
import { renderStandardSkillFile } from './standard-skills.js'

interface DeploymentFile {
  readonly target: string
  readonly content: string
  readonly previous: RegularFileSnapshot | undefined
}

export interface StandardSkillDeployment {
  readonly directory: string
  readonly created: number
  readonly updated: number
  readonly unchanged: number
}

/** Check each component below the canonical home without following directory links. */
async function deploymentParent(home: string, target: string, create: boolean): Promise<void> {
  let directory = home
  for (const component of path.relative(home, path.dirname(target)).split(path.sep)) {
    directory = path.join(directory, component)
    if (create) {
      try { await mkdir(directory, { mode: 0o700 }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    try {
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()
        || (process.getuid !== undefined && (info.uid !== process.getuid() || (info.mode & 0o022) !== 0))) {
        throw new KiokukoError('SECURITY_REJECTION', `Unsafe standard Skill directory: ${directory}`)
      }
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

function sameSnapshot(left: RegularFileSnapshot | undefined, right: RegularFileSnapshot | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.content === right.content && left.mode === right.mode
    && left.identity.device === right.identity.device && left.identity.inode === right.identity.inode
}

/** Publish one complete file atomically; never truncate an existing file or follow its links. */
async function publishFile(home: string, file: DeploymentFile): Promise<'created' | 'updated' | 'unchanged'> {
  await deploymentParent(home, file.target, true)
  const temporary = await mkdtemp(path.join(path.dirname(file.target), '.kiokuko-skill-'))
  try {
    const staged = path.join(temporary, 'content')
    await writeFile(staged, file.content, { flag: 'wx', mode: file.previous?.mode ?? 0o600 })
    await deploymentParent(home, file.target, false)
    const current = await readRegularFile(file.target, { containmentRoot: home })
    if (current?.content === file.content) return 'unchanged'
    if (!sameSnapshot(current, file.previous)) {
      throw new KiokukoError('CONFLICT', `Standard Skill changed during synchronization: ${file.target}`)
    }
    if (current === undefined) {
      // link is exclusive: another process creating the target must not be overwritten.
      try { await link(staged, file.target) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
          || (await readRegularFile(file.target, { containmentRoot: home }))?.content !== file.content) throw error
        return 'unchanged'
      }
      return 'created'
    }
    await rename(staged, file.target)
    return 'updated'
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

/** Sync only the fixed, validated six-Skill manifest. Unlisted user files are never removed. */
export async function synchronizeStandardSkills(homeDirectory: string = os.homedir()): Promise<StandardSkillDeployment> {
  if (!path.isAbsolute(homeDirectory) || homeDirectory.includes('\0') || path.resolve(homeDirectory) === path.parse(homeDirectory).root) {
    throw new KiokukoError('VALIDATION_ERROR', 'Standard Skill deployment requires an absolute user home')
  }
  const home = await realpath(homeDirectory)
  const directory = path.join(home, '.agents', 'skills')
  const parity = await loadStandardSkillParity()
  const files: DeploymentFile[] = []
  // Preflight the complete manifest before creating or replacing any deployed file.
  for (const bundled of parity.files) {
    const target = path.join(directory, bundled.skillName, bundled.relativePath)
    await deploymentParent(home, target, false)
    const previous = await readRegularFile(target, { containmentRoot: home })
    const rendered = renderStandardSkillFile(previous?.content, bundled, target)
    files.push({ target, content: rendered.content, previous })
  }
  const result = { directory, created: 0, updated: 0, unchanged: 0 }
  for (const file of files) {
    if (file.previous?.content === file.content) result.unchanged++
    else result[await publishFile(home, file)]++
  }
  // Atomicity is per file. An interrupted tree is completed on the next plugin load.
  return result
}

/** Deployment failure is visible but does not replace or veto the bundled provider. */
export async function synchronizeStandardSkillsOnLoad(): Promise<void> {
  try {
    const result = await synchronizeStandardSkills()
    if (result.created || result.updated) {
      console.info(`[kiokuko-dsh] [info] Standard Skills synchronized: ${result.created} created, ${result.updated} updated (${result.directory})`)
    }
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN'
    console.warn(`[kiokuko-dsh] [warn] Standard Skill synchronization failed (${code}); deployed copies may be stale. Check ~/.agents/skills for unmanaged files, symbolic links, or permission errors. Bundled DSH Skills remain available.`)
  }
}
