// Transport only: consumer installation needs the host's configured network route,
// not its credentials, npmrc, lifecycle settings, or Node execution flags.
const transportKeys = Object.freeze([
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'npm_config_proxy', 'npm_config_http_proxy', 'npm_config_https_proxy', 'npm_config_noproxy',
  'NPM_CONFIG_PROXY', 'NPM_CONFIG_HTTP_PROXY', 'NPM_CONFIG_HTTPS_PROXY', 'NPM_CONFIG_NOPROXY',
  'NODE_EXTRA_CA_CERTS', 'npm_config_cafile', 'NPM_CONFIG_CAFILE',
])

/** Isolated npm consumer-install environment; never use for native engine checks. */
export function consumerInstallEnvironment(inherited, { home, cache }) {
  const environment = { PATH: inherited.PATH, HOME: home, npm_config_cache: cache }
  for (const key of transportKeys) {
    if (Object.hasOwn(inherited, key) && typeof inherited[key] === 'string' && inherited[key].length > 0) environment[key] = inherited[key]
  }
  if (inherited.NODE_USE_ENV_PROXY === '1' || inherited.NODE_USE_ENV_PROXY === '0') environment.NODE_USE_ENV_PROXY = inherited.NODE_USE_ENV_PROXY
  return environment
}
