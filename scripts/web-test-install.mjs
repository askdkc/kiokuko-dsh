import { realpathSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

// pnpm matches a local archive's build approval against its file reference
// relative to the profile. The package name alone does not match.
export function webTarballInstallArgs(archive, dshHome) {
  const home = resolve(dshHome)
  const profile = join(realpathSync(dirname(home)), basename(home), 'profiles', 'web')
  const tarball = realpathSync(archive)
  const reference = relative(profile, tarball).split(sep).join('/')
  return ['plugin', '--profile', 'web', 'add', tarball, `--allow-build=kiokuko-dsh@file:${reference}`]
}
