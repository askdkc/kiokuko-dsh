# PR #72: on-demand intake regression checks

The public default remains `on-demand`. Ordinary questions must reach the
native model without opening execution intake, asking a purpose question, or
creating an execution ledger. Tool-backed requests use the original human
input and `prepare_requested_work`, then retain native permissions, memory
review, and execution guards.

Native fixtures now prepare each new work request, including human resume
after unload/reload. The persisted Enno fixture creates the same session
ownership receipt as production; it does not replace the default with eager
intake. Eager compatibility tests remain explicitly identified.

The fixed harness retains all original eleven scenario names and assertions.
It additionally checks default persisted resume. Its reviewed fixture digest
changes because the native fixture records session ownership and prepares the
second work request, and because the additional case uses the public default.
No scenario is removed or skipped, and the runner still requires exactly one
passing, unskipped test per selected scenario.

## Offline optional Skill discovery

The optional community lookup originates in task intake's
`resolveSkillDiscovery`, through `discoverSkills` and
`SkillsShCompatibilityProvider`. It sends an HTTPS GET to
`skills.sh/api/search` with a technology search query, result limit, and
optional owner filter. This search does not send the original task as a POST
body. Production discovery settings are unchanged.

The aggregate, fixed harness, and Skill delivery test runners preload
`tests/dsh/helpers/offline-skill-catalog.mjs`, including child processes.
Only the supported community search boundary receives an empty catalog
fixture. Unsupported requests to that host fail instead of contacting it or
using another route. Other origins retain the supplied fetch implementation,
so local service fixtures and explicit provider serializer fixtures continue
to exercise their own boundaries. The catalog unit tests verify interception,
unsupported-request refusal, and delegation to a local origin.

## Dedicated checks

Run the standard suite separately from Skill delivery: standard package tests
can replace build artifacts while the dedicated delivery suite checks exact
compiled bodies. Build before running source and packed delivery checks.

```sh
npm run typecheck
npm test
npm run build
npm run test:harness
npm run test:skill-delivery
npm run test:modules
KIOKUKO_REQUIRE_LISP_RUNTIME=1 \
  KIOKUKO_DSH_PACKAGE_ROOT="$PWD/tests/fixtures/dsh-runtime/node_modules" \
  npm run test:lisp
KIOKUKO_REQUIRE_DSH_NATIVE=1 \
  KIOKUKO_DSH_PACKAGE_ROOT="$PWD/tests/fixtures/dsh-runtime/node_modules" \
  npm test
```

Native preparation, PTC/memory review, Deep follow-up, and tombstone tests
must run with the canonical DSH fixture. Protected Lisp and source/packed
delivery require the actual supported runtime. A socket-denied test is a
failed environmental check, not passing evidence. The optional macOS P0
seatbelt probe has a separate explicit opt-in; its skip is not protection
evidence.

The prototype HTTP control uses the actual native provider serializer with
an injected HTTP fixture. Its scripted preparation, runtime inspection, and
seed execute in the same native turn before measured requests. The wrapper
preserves the provider generation frozen by `prepareCall`; wrapping only
`adapter.stream` misses DeepSeek's frozen dispatch path. This fixture proves
ordering and budgets, not live model quality. Fixtures retain the selected runtime's
native serializer, authentication callback, SSE format, and tool-result identity;
the request boundary accepts only the corresponding endpoint on the configured
origin. It never retries through another provider or protocol.

Completion requires the final pushed commit's GitHub CI results. Local test
results do not substitute for verify, macOS runtime smoke, DSH compatibility,
or the Protected Lisp jobs.
