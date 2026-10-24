# Native DSH test runtime

CI resolves `deepseek-ai/deepseek-harness` `master` once per run. Every native lane
checks out that exact SHA, installs its frozen pnpm graph with its declared package
manager, builds official artifacts, and stages the built workspace packages here and into the root development graph.
The source SHA and release label are retained in `dsh-upstream.json` with each
verification artifact. The official checkout is never patched.

The tracked npm manifest/lock retain a reproducible historical baseline and the
separately versioned CLI/terminal test support. They are not the current-upstream
compatibility target. Staging replaces the entire `@deepseek-ai` scope so a removed
upstream package cannot silently fall back to the old release.

To reproduce a CI revision, check out the recorded SHA in an official DSH clone,
run its frozen pnpm install and `pnpm run build:artifacts`, then run:

```sh
npm ci --prefix tests/fixtures/dsh-runtime
node scripts/stage-dsh-upstream.mjs /path/to/deepseek-harness tests/fixtures/dsh-runtime <recorded-full-sha> .
npm run test:ci:unit
npm run test:ci:integration
```

An explicit `KIOKUKO_DSH_SOURCE_ROOT` is preserved, but its manifest identity must
match the selected package view. `KIOKUKO_EXPECTED_DSH_SHA` additionally requires
the exact staged upstream commit. Release versions and lockfiles remain identity
and reproducibility data, not arbitrary compatibility gates.
