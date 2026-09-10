# Native DSH CI runtime

Both native CI jobs copy this manifest and lockfile into a disposable directory
and install with `npm ci`. Pinning only `@deepseek-ai/dsh` is insufficient:
its internal dependencies use caret ranges, so an install of `0.1.5-rc.1` can
resolve internal packages to `0.1.5-rc.2` or later releases.

The overrides keep all DSH packages at the tested release; the lockfile also
fixes the remaining dependency graph and package integrity. These are test
dependencies, independent of Kiokuko's published package dependencies.

To intentionally update the runtime, update the CLI dependency and every DSH
override together, regenerate the lockfile from an empty temporary directory,
and copy the resulting lockfile back here:

```sh
dsh_lock_dir="$(mktemp -d)"
cp tests/fixtures/dsh-runtime/package.json "$dsh_lock_dir/"
npm install --prefix "$dsh_lock_dir" --package-lock-only --ignore-scripts
cp "$dsh_lock_dir/package-lock.json" tests/fixtures/dsh-runtime/package-lock.json
```

Check every locked `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` package, including
nested packages, against the intended release and add overrides for any newly
introduced DSH packages. Update the native tests' expected version and both CI
jobs together, then run the complete mandatory native lifecycle suite using a
clean install of this fixture and the CI Node.js version. Do not weaken the
version assertions to accept a mixed runtime.
