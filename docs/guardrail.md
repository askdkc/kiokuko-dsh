# kiokuko-dsh bundled Rust guardrail

The opt-in `bounded-tdd-v1` recipe restricts an existing kiokuko-dsh coding unit to write-tests → verify-red → implement → verify-green → report. Completion bindings follow the existing host approval policy, which may approve automatically; enrollment is not a new human-confirmation step or a grant of filesystem/task authority. A unit may span several files. One fresh RED opens its bounded implementation phase; GREEN requires a net source change and closes that phase. Tests stay frozen after RED. Broadening the unit requires the existing coding-scope amendment flow and fresh evidence.

The host binds receipts to the current task lease, recipe generation, completion binding, separate source/test manifests, exact selected command, Node/runner/supervisor/engine/protocol bytes, and a bounded environment. Tests receive fresh HOME/TMP/XDG directories and a fixed PATH/LANG/TZ, not inherited credentials or arbitrary environment variables. Node's private structured event channel supplies observations; stdout, JSON claims and a nonzero exit cannot issue receipts. Assertion-shaped events require structured assertion fields. Model-written tests can still fabricate assertion semantics or test the wrong behavior; this is not proof of semantic correctness or hostile same-user process attestation.

Each owned write and test launch receives final transactional lease reauthorization. Cancellation committed before that boundary prevents the effect; a later cancellation must stop an already-started process. File staging and replacement are synchronous within the checked write boundary. SQLite and filesystem effects are not one atomic transaction: a crash may leave changed files with a pending operation. Such operations remain blocked for inspection, stop confirmation, explicit task resume and fresh rebinding instead of automatic replay or rollback. A database retry cannot repeat an already-entered effect callback; an uncertain launch stays pending even when the caller changes its call ID.

Completion status exposes separate capability metadata for bounded protocol validation, lease-checked owned effects, process-only Node tests, and protected-required Lisp effects; rollback and heap restoration are false. Selected Node tests are ordinary JavaScript: the runner is not an OS sandbox against undeclared filesystem or network effects.

The bounded CL-like language is declarative, without arbitrary Common Lisp evaluation or heap restoration. Existing workflow metadata and task authority remain the only state authority. Enrolled Lisp effects require the protected owned-tool route; unrestricted development Lisp is unavailable while enrolled. The guardrail is not an OS sandbox or global permission system. Hashes identify inputs and ordinary integrity, not malicious same-user filesystem races. Non-enrolled work retains its existing behavior.

## Installation and checks

The full package and core module include precompiled artifacts, protocol, Node runner and resolver. Engine selection uses no Cargo, SBCL, download, PATH fallback or install-time compilation. The normal build, including Git-install prepare, verifies bundled assets.

- `npm run verify:guardrail`: verify all bundled hashes, modes, ELF/Mach-O structure and recorded native-execution status without running cross-built binaries.
- `npm run check:guardrail`: verify availability and integrity for the current host; missing or invalid assets fail closed.

`package.json` pins `guardrail/manifest.json`, which binds protocol bytes, each executable and its original release manifest. Manifests include source/build inputs and compiler/linker provenance. Product and engine versions are independently metadata-derived. The resolver rejects symlinks, non-regular/non-executable files, malformed or truncated executables, wrong architectures and identity mismatches.

## Target status

- Linux x64: static musl ELF; native CLI smoke and reproducible-build checks passed on Linux x64.
- Linux ARM64: static musl ELF, cloud cross-built; native execution not run.
- macOS Apple Silicon (ARM64): cloud cross-built Mach-O, minimum macOS 13; native execution not run. ARM64 ad-hoc signature structure was checked.
- Intel Mac and other hosts: unsupported; no substitute architecture is selected.

Cross-build, format and hash checks do not establish native compatibility, arbitrary runtime behavior, notarization or developer signing. Package smoke execution applies only to its actual host. Linux musl binaries have no dynamic ELF interpreter.

## Repository source and maintenance

The repository includes the actual dependency-free Rust library/CLI at [crates/guardrail](../crates/guardrail/README.md), including the restricted-language/evidence-wire specification, protocol, Cargo lockfile and tests. [Build and release instructions](../crates/guardrail-release/BUILDING.md) accompany the pinned official-source toolchain inputs and portable offline recipe. This source/build layer is excluded from npm runtime tarballs; runtime [third-party notices](guardrail-licenses/README.md) remain included. Original recorded repeat-build evidence does not mean an adapted wrapper has reproduced every target. Historical Intel Mac records remain in the frozen source and release provenance for identity verification; they do not describe current shipping support.
