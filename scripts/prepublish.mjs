import { spawnSync } from 'node:child_process'

// npm exports .npmrc allow-scripts into lifecycle environments, but rejects
// that environment setting for project installs. Let ci read the original npmrc.
const env = { ...process.env }
delete env.npm_config_allow_scripts
delete env.NPM_CONFIG_ALLOW_SCRIPTS
// A publish dry-run still needs real build dependencies for the prepare step.
delete env.npm_config_dry_run
delete env.NPM_CONFIG_DRY_RUN

const result = spawnSync(process.execPath, [
  process.env.npm_execpath,
  'ci', '--include=dev', '--include=optional', '--ignore-scripts',
], { env, stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
