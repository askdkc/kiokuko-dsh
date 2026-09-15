import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Find the active profile without reading settings, credentials, or session data. */
export function startupProfile(argv: readonly string[], baseUrl?: string): string | undefined {
  if (baseUrl !== undefined) {
    try {
      const directory = dirname(fileURLToPath(baseUrl))
      if (basename(dirname(directory)) === 'profiles') return basename(directory)
    } catch { /* A non-file composition has no profile-directory evidence. */ }
  }
  const args = argv.slice(2)
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--') break
    if (arg.startsWith('--profile=')) return arg.slice('--profile='.length) || undefined
    if (arg === '--profile') return args[index + 1] || undefined
  }
  return args[0] === 'web' ? 'web' : undefined
}

/** Actionable recovery steps; reinstall is a suggestion, never an automatic mutation. */
export function startupRecoveryMessage(argv: readonly string[], baseUrl?: string): string {
  const profile = startupProfile(argv, baseUrl)
  // DSH profile names are identifiers, not shell fragments. Unknown names stay placeholders.
  const profileArg = profile !== undefined && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profile) ? profile : 'PROFILE_NAME'
  const sourceLaunch = /[/\\]apps[/\\]cli[/\\]src[/\\]bin\.[cm]?ts$/.test(argv[1] ?? '')
  const cli = sourceLaunch ? 'pnpm dsh' : 'dsh'
  return [
    'Kiokuko could not start. If this began after updating DSH, stop DSH and update the plugin in the same profile:',
    `  ${cli} plugin --profile ${profileArg} update kiokuko-dsh --latest`,
    'For an npm installation that is still broken, reinstall its package files:',
    `  ${cli} plugin --profile ${profileArg} add kiokuko-dsh@latest --force`,
    'For GitHub/local installs, reinstall the original package spec instead of switching to npm.',
    `Restart DSH with the same profile: ${cli} --profile ${profileArg}`,
    ...(profileArg === 'PROFILE_NAME' ? ['Replace PROFILE_NAME with the profile used for this launch.'] : []),
    'Reinstallation cannot fix every DSH API mismatch. If the error persists, retain the original error and check DSH/plugin compatibility.',
    'Do not delete session logs, the Kiokuko database, or profile settings to recover from a plugin startup failure.',
  ].join('\n')
}

/** Preserve the original rejection while printing recovery advice for module-load failures. */
export async function loadDshPlugin<T>(load: () => Promise<T>): Promise<T> {
  try { return await load() } catch (error) {
    console.error('[kiokuko-dsh] [crit] Plugin could not be loaded:', error instanceof Error ? error.message : String(error))
    console.error(startupRecoveryMessage(process.argv))
    throw error
  }
}
