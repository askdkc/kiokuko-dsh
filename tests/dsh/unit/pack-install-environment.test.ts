import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { consumerInstallEnvironment } from '../../../scripts/pack-install-environment.mjs'

test('consumer installation retains only explicit transport and isolated directories', () => {
  const inherited = {
    PATH: '/tools', HOME: '/private-home', npm_config_cache: '/private-cache',
    HTTP_PROXY: 'http://proxy.invalid:8080', https_proxy: 'http://proxy.invalid:8080',
    ALL_PROXY: 'http://proxy.invalid:8080', no_proxy: 'localhost',
    npm_config_proxy: 'http://proxy.invalid:8080', NPM_CONFIG_HTTPS_PROXY: 'http://proxy.invalid:8080',
    npm_config_noproxy: 'localhost', NODE_EXTRA_CA_CERTS: '/configured/proxy-ca.pem',
    NODE_USE_ENV_PROXY: '1', NPM_CONFIG_CAFILE: '/configured/npm-ca.pem',
    NPM_TOKEN: 'secret', npm_config__authToken: 'secret', GITHUB_TOKEN: 'secret',
    npm_config_userconfig: '/private-home/.npmrc', NPM_CONFIG_USERCONFIG: '/private-home/.npmrc',
    NODE_OPTIONS: '--require /private-hook.js', NODE_TLS_REJECT_UNAUTHORIZED: '0',
    npm_config_registry: 'https://unrelated.invalid', npm_config_ignore_scripts: 'false',
  }
  const environment = consumerInstallEnvironment(inherited, { home: '/isolated-home', cache: '/isolated-cache' })
  assert.deepEqual(environment, {
    PATH: '/tools', HOME: '/isolated-home', npm_config_cache: '/isolated-cache',
    HTTP_PROXY: inherited.HTTP_PROXY, https_proxy: inherited.https_proxy, ALL_PROXY: inherited.ALL_PROXY,
    no_proxy: 'localhost', npm_config_proxy: inherited.npm_config_proxy,
    NPM_CONFIG_HTTPS_PROXY: inherited.NPM_CONFIG_HTTPS_PROXY, npm_config_noproxy: 'localhost',
    NODE_EXTRA_CA_CERTS: '/configured/proxy-ca.pem', NPM_CONFIG_CAFILE: '/configured/npm-ca.pem', NODE_USE_ENV_PROXY: '1',
  })
  assert.equal(inherited.HOME, '/private-home')
})

test('consumer transport absence and invalid proxy toggle do not expand inheritance', () => {
  assert.deepEqual(consumerInstallEnvironment({ PATH: '/tools', HTTP_PROXY: '', NODE_USE_ENV_PROXY: 'unexpected', secret: 'secret' }, { home: '/home', cache: '/cache' }), { PATH: '/tools', HOME: '/home', npm_config_cache: '/cache' })
})

test('pack transport applies only to consumer installation, not native engine execution', () => {
  const source = readFileSync(new URL('../../../scripts/pack-check.mjs', import.meta.url), 'utf8')
  assert.equal(source.match(/consumerInstallEnvironment\(process.env/g)?.length, 1)
  assert.match(source, /cwd: consumerRoot, env: consumerInstallEnvironment\(process.env, \{ home: work, cache \}\)/)
  assert.match(source, /exec\(guardrail.binary, \['--version'\], \{ cwd: extractRoot, env: \{ PATH: '', HOME: work \}/)
  assert.match(source, /exec\(guardrail.binary, \['validate', guardrail.protocol\], \{ cwd: extractRoot, env: \{ PATH: '', HOME: work \}/)
  assert.match(source, /timeoutMs: 180_000/)
  assert.match(source, /'install', '--ignore-scripts', '--omit=optional'/)
})
