# Maintaining the bundled Rust guardrail

The actual dependency-free Rust library and CLI live in `../guardrail/`. Its README is the restricted protocol specification: reader grammar, supported forms and budgets, protocol declarations, evidence wire schema, authority boundary and CLI exit meanings. `examples/coding-routine.lisp` is the declarative protocol shipped by the plugin. The crate includes its Cargo lockfile, eight integration suites and the original portable test/package scripts. The repository's root MIT license covers this source.

Keep the exact 22-file crate separate from these release maintenance files. The original packaging algorithm hashes all source files; placing new release notes or provenance inside the crate would change its release source identity. `source-manifest.json` preserves the full source map and canonical source digest. Tests compare it with the bundled artifact's original release manifest.

## Ordinary source development

From the repository root, with Rust 1.85+ and Python 3.11+ already installed (the package/tests use Python tomllib):

    cargo test --manifest-path crates/guardrail/Cargo.toml --locked --offline
    cargo build --manifest-path crates/guardrail/Cargo.toml --locked --offline --release

Use an external `CARGO_TARGET_DIR` to keep build output outside the source tree. The engine has no third-party Rust dependencies. The test wrapper additionally separates assertion failures (exit 1) from compiler/setup failure (exit 2) and timeout (exit 4):

    python3 crates/guardrail/scripts/test.py /absolute/path/to/cargo /absolute/path/to/rustc all

## Reproducing the recorded release

The recorded builds use official Rust 1.99.0 components and, for macOS cross-builds, Zig 0.17.0. `release-provenance.json` records the official distribution URLs and SHA-256 values, compiler/linker identities, target-specific original build inputs and per-target verification status. Install those tools yourself into a dedicated directory, verify their distribution hashes, and pass their explicit executable paths. This repository does not download or install toolchains during npm install or guardrail enrollment.

The helper accepts existing tools only. It verifies the frozen source and compiler/linker hashes, builds twice in fresh temporary directories using `--locked --offline`, `SOURCE_DATE_EPOCH=0` and source/temp path remapping, compares both binaries with the recorded binary, then invokes the original deterministic packaging script and compares the archive hash. Output must be outside the repository. `--plan` validates identities and prints the recipe without compiling or writing output.

Example Linux x64 static-musl reproduction (substitute your installed, verified paths):

    python3 crates/guardrail-release/release.py --target x86_64-unknown-linux-musl --cargo /absolute/rust/bin/cargo --rustc /absolute/rust/bin/rustc --cc /usr/bin/cc --ld /usr/bin/ld --output /absolute/out/guardrail-release --plan

Remove `--plan` to perform the two builds and package verification. The helper binds Cargo’s target linker directly to the verified `cc`. The `ld` hash records an environment input; the compiler driver’s effective linker search is not enforced. Final binary/archive identity checks remain necessary. Compiler arguments are passed through `CARGO_ENCODED_RUSTFLAGS` with 0x1f separators so source/temporary paths containing spaces remain single arguments (see the [Cargo environment-variable reference](https://doc.rust-lang.org/cargo/reference/environment-variables.html)). The pinned `cc`/`ld` hashes describe the recorded Debian build environment; a different compiler/linker is rejected rather than silently producing an unverified replacement. The recorded helper is for a Linux x64 toolchain host. Ordinary native source development uses Cargo directly.

Existing cross-target recipes use the same helper and explicit target tool paths:

- Linux ARM64 musl: `--target aarch64-unknown-linux-musl --rust-lld /absolute/rust/lib/rustlib/x86_64-unknown-linux-gnu/bin/rust-lld`. The recipe adds `-C linker-flavor=ld.lld -C link-self-contained=yes`.
- macOS Intel: `--target x86_64-apple-darwin --zig /absolute/zig/zig`.
- macOS Apple Silicon: `--target aarch64-apple-darwin --zig /absolute/zig/zig`.
- macOS recipes use `zig cc -s`, a target minimum of macOS 13, `MACOSX_DEPLOYMENT_TARGET=13.0`, and isolated Zig caches.

The four target JSON files retain the exact normalized build-input records used for the shipped archives. Compiler binaries alone do not pin every sysroot/system-library byte; distribution hashes and recorded linker identities are relevant inputs. This is not a fully isolated derivation, a signed supply-chain attestation, or a promise that a different host reproduces identical output. Mismatched results fail visibly.

This parameterized wrapper is adapted from the recorded build commands. Its input/plan validation is separate from executing a build; no adapted-wrapper cross-target reproduction is claimed. Original two-build identity records refer to the original captured toolchain executions.

Only Linux x64 smoke execution was performed for this release. Linux ARM64 and both macOS executables were cross-built and structurally checked; native execution remains unrun. The helper never treats cross-build success as native verification. There is no Windows artifact or new platform work in this delivery.

## Updating a release

Changes to the crate require real test evidence, a reviewed source-manifest update and fresh build/provenance records. Rebuild the intended targets, record native acceptance separately, update the bundled runtime artifacts and their pinned manifests, then rerun npm package/core/composition checks. Do not relabel existing artifact hashes or old test receipts as evidence for changed source.

The npm runtime package deliberately excludes `crates/`: it ships the checked precompiled binaries, bounded protocol, host runner, resolver and existing dist output. Consumers need neither Cargo nor a Lisp runtime for this Rust guardrail. The source and complete maintenance recipe remain in the repository deliverable.
