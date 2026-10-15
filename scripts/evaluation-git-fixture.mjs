import { execFileSync } from 'node:child_process'
import { devNull } from 'node:os'

/** The caller owns and cleans the disposable directory. No inherited Git
 * overrides or configured templates may redirect initialization elsewhere. */
export function initializeEvaluationRepository(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  Object.assign(env, { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' })
  execFileSync('git', ['init', '--quiet', '--template=', root], {
    env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
  })
}
