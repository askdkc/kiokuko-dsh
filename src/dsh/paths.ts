import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { KiokukoError } from '../errors.js'

export interface DshPathEnvironment {
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
}

function selected(options: DshPathEnvironment): { platform: NodeJS.Platform; env: NodeJS.ProcessEnv } {
  return { platform: options.platform ?? process.platform, env: options.env ?? process.env }
}

function configuredDataDirectory(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | undefined {
  const configured = env.KIOKUKO_DATA_DIR
  if (configured === undefined) return undefined
  const platformPath = platform === 'win32' ? path.win32 : path.posix
  if (configured.length === 0 || configured.length > 4_096 || configured !== configured.trim()
    || configured.includes('\0') || !platformPath.isAbsolute(configured)) {
    throw new KiokukoError('VALIDATION_ERROR', 'KIOKUKO_DATA_DIR must be a bounded absolute path')
  }
  const normalized = platformPath.normalize(configured)
  if (normalized === platformPath.parse(normalized).root) {
    throw new KiokukoError('VALIDATION_ERROR', 'KIOKUKO_DATA_DIR must not be a filesystem root')
  }
  return normalized
}

export function getDshDataDirectory(options: DshPathEnvironment = {}): string {
  const { platform, env } = selected(options)
  const join = platform === 'win32' ? path.win32.join : path.posix.join
  const configured = configuredDataDirectory(platform, env)
  if (configured !== undefined) return configured
  if (platform === 'win32') {
    const root = env.LOCALAPPDATA ?? env.APPDATA ?? env.USERPROFILE
    if (root === undefined) throw new KiokukoError('VALIDATION_ERROR', 'A Windows user data directory is unavailable')
    return join(root, 'kiokuko')
  }
  if (platform === 'darwin') {
    if (env.HOME === undefined) throw new KiokukoError('VALIDATION_ERROR', 'HOME is unavailable')
    return join(env.HOME, 'Library', 'Application Support', 'kiokuko')
  }
  const root = env.XDG_DATA_HOME ?? (env.HOME === undefined ? undefined : join(env.HOME, '.local', 'share'))
  if (root === undefined) throw new KiokukoError('VALIDATION_ERROR', 'XDG_DATA_HOME or HOME is unavailable')
  return join(root, 'kiokuko')
}

export async function ensureDshDataDirectory(options: DshPathEnvironment = {}): Promise<string> {
  const directory = getDshDataDirectory(options)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  return directory
}

export function getDshDatabasePath(options: DshPathEnvironment = {}): string {
  const { platform } = selected(options)
  const join = platform === 'win32' ? path.win32.join : path.posix.join
  return join(getDshDataDirectory(options), 'kiokuko-dsh.sqlite3')
}

function embeddingCoordinate(value: string, field: 'preset' | 'revision'): string {
  const valid = field === 'preset' ? /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value) : /^[0-9a-f]{40}$/u.test(value)
  if (!valid) throw new KiokukoError('VALIDATION_ERROR', `${field} is invalid`)
  return value
}

export function getDshEmbeddingPresetDirectory(
  preset: string,
  revision: string,
  options: DshPathEnvironment = {},
): string {
  const { platform } = selected(options)
  const join = platform === 'win32' ? path.win32.join : path.posix.join
  return join(
    getDshDataDirectory(options),
    'models',
    'embeddings',
    embeddingCoordinate(preset, 'preset'),
    embeddingCoordinate(revision, 'revision'),
  )
}
