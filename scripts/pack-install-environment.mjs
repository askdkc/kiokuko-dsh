import { spawn } from 'node:child_process'
import { observeProcess } from './verification-diagnostics.mjs'
// Transport only: consumer installation needs the host's configured network route,
// not its credentials, npmrc, lifecycle settings, or Node execution flags.
const transportKeys = Object.freeze([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'npm_config_proxy',
  'npm_config_http_proxy',
  'npm_config_https_proxy',
  'npm_config_noproxy',
  'NPM_CONFIG_PROXY',
  'NPM_CONFIG_HTTP_PROXY',
  'NPM_CONFIG_HTTPS_PROXY',
  'NPM_CONFIG_NOPROXY',
  'NODE_EXTRA_CA_CERTS',
  'npm_config_cafile',
  'NPM_CONFIG_CAFILE',
])

/** Isolated npm consumer-install environment; never use for native engine checks. */
export function consumerInstallEnvironment(inherited, { home, cache }) {
  const environment = {
    PATH: inherited.PATH,
    HOME: home,
    npm_config_cache: cache,
  }
  for (const key of transportKeys) {
    if (
      Object.hasOwn(inherited, key) &&
      typeof inherited[key] === 'string' &&
      inherited[key].length > 0
    )
      environment[key] = inherited[key]
  }
  if (
    inherited.NODE_USE_ENV_PROXY === '1' ||
    inherited.NODE_USE_ENV_PROXY === '0'
  )
    environment.NODE_USE_ENV_PROXY = inherited.NODE_USE_ENV_PROXY
  return environment
}

/** Keep the consumer install within its deadline, including npm shutdown. */
export function installPackedConsumer(
  archive,
  { cwd, home, cache, inherited = process.env, timeoutMs = 180000 },
) {
  return observeProcess(
    (signal) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          'npm',
          [
            'install',
            '--ignore-scripts',
            '--omit=optional',
            '--no-audit',
            '--no-fund',
            '--prefer-offline',
            '--fetch-timeout=30000',
            '--fetch-retries=1',
            '--fetch-retry-mintimeout=1000',
            '--fetch-retry-maxtimeout=5000',
            archive,
          ],
          {
            cwd,
            env: consumerInstallEnvironment(inherited, { home, cache }),
            stdio: ['ignore', 'ignore', 'pipe'],
            detached: process.platform !== 'win32',
          },
        )
        let stderr = '',
          killed = false,
          grace
        const send = (name) => {
          try {
            if (process.platform === 'win32') child.kill(name)
            else if (child.pid !== undefined) process.kill(-child.pid, name)
          } catch (error) {
            if (error.code !== 'ESRCH') throw error
          }
        }
        const stop = () => {
          if (killed) return
          killed = true
          send('SIGTERM')
          grace = setTimeout(() => send('SIGKILL'), 5000)
        }
        const cleanup = () => {
          clearTimeout(grace)
          signal.removeEventListener('abort', stop)
          process.off('SIGTERM', stop)
          process.off('SIGINT', stop)
        }
        child.stderr.on('data', (chunk) => {
          stderr = (stderr + chunk).slice(-32768)
        })
        signal.addEventListener('abort', stop, { once: true })
        process.once('SIGTERM', stop)
        process.once('SIGINT', stop)
        child.once('error', (error) => {
          cleanup()
          reject(Object.assign(error, { stderr, killed }))
        })
        child.once('close', (code, childSignal) => {
          cleanup()
          if (code === 0 && !killed) resolve({ stderr })
          else
            reject(
              Object.assign(new Error('Consumer install failed'), {
                code,
                signal: childSignal,
                killed,
                stderr,
              }),
            )
        })
      }),
    { point: 'pack-install', timeoutMs },
  )
}
