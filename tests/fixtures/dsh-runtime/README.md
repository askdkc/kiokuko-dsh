# Native DSH CI runtime

This is the single runtime fixture used by native tests and CI. Its manifest
selects the supported DSH release; the lockfile fixes the full dependency graph
and package integrity. Install it with `npm ci --prefix tests/fixtures/dsh-runtime`.

Runtime runners and CI derive their expected DSH version from this manifest.
There is no separate old-release test target. These are test dependencies,
independent of Kiokuko's published package version.

To update the baseline, verify the intended upstream release and its npm
publication, then update the exact dependency and regenerate the lockfile:

```sh
npm install --prefix tests/fixtures/dsh-runtime --save-exact '@deepseek-ai/dsh@<verified-version>'
npm run test:ci:unit
npm run test:ci:integration
```

Check the locked DSH package versions against the selected release. Align root
DSH development dependencies and the package compatibility declaration. Regenerate
the root npm lockfile, then run `pnpm import` to synchronize its pnpm lockfile. Then
run the native lifecycle and packaged checks with the CI Node.js version.
The npm `latest` tag may lag behind an upstream prerelease, so do not treat the
tag name as proof of the newest release.
