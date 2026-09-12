import { link, lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readRegularFile, type RegularFileSnapshot } from '../config/read-regular-file.js'
import { KiokukoError } from '../errors.js'

export interface DeploymentFile {
  readonly target: string
  readonly content: string
  readonly previous: RegularFileSnapshot | undefined
}

/** Check each component below the canonical home without following directory links. */
export async function deploymentParent(home: string, target: string, create: boolean): Promise<void> {
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
        throw new KiokukoError('SECURITY_REJECTION', `Unsafe managed file directory: ${directory}`)
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
export async function publishFile(home: string, file: DeploymentFile): Promise<'created' | 'updated' | 'unchanged'> {
  await deploymentParent(home, file.target, true)
  const temporary = await mkdtemp(path.join(path.dirname(file.target), '.kiokuko-skill-'))
  try {
    const staged = path.join(temporary, 'content')
    await writeFile(staged, file.content, { flag: 'wx', mode: file.previous?.mode ?? 0o600 })
    await deploymentParent(home, file.target, false)
    const current = await readRegularFile(file.target, { containmentRoot: home })
    if (current?.content === file.content) return 'unchanged'
    if (!sameSnapshot(current, file.previous)) {
      throw new KiokukoError('CONFLICT', `Managed file changed during synchronization: ${file.target}`)
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

