# Maintaining the bundled Rust guardrail

The dependency-free Rust library/CLI lives in `../guardrail/`. The source manifest enumerates every crate file and its digest; the count is not a fixed API. Keep generated build output outside that directory. The shipped protocol remains byte-identical to `examples/coding-routine.lisp`.

## Ordinary source development

With Rust 1.85+ and Python 3.11+ installed:

    cargo test --manifest-path crates/guardrail/Cargo.toml --locked --offline
    cargo build --manifest-path crates/guardrail/Cargo.toml --locked --offline --release

Use an external `CARGO_TARGET_DIR`. The crate has no downloaded dependencies. The optional `scripts/test.py` wrapper distinguishes assertion failures from setup failures and timeouts.

## Recorded release recipe

The release index defines three shipping targets: Linux x64 static musl, Linux ARM64 static musl, and macOS ARM64. Intel Mac and Windows are not supported by this release. Official Rust 1.99.1 distribution components and Zig 0.17.0 are recorded with their archive digests in `release-provenance.json`; compiler/linker executable hashes are recorded separately. The package does not download or install toolchains at installation or enrollment.

`release.py` accepts explicit installed tool paths. It checks the complete frozen source and pinned tool identities, builds twice in separate temporary directories with `--locked --offline`, `SOURCE_DATE_EPOCH=0`, and remapped source/temp paths. Compiler arguments use `CARGO_ENCODED_RUSTFLAGS` separators, preserving paths containing spaces. Both output byte strings must match. The source set is read again after building, so concurrent source edits invalidate the receipt. Use an external `TMPDIR` and output directory with sufficient space.

    python3 crates/guardrail-release/release.py --target x86_64-unknown-linux-musl --cargo /absolute/rust/bin/cargo --rustc /absolute/rust/bin/rustc --cc /usr/bin/cc --ld /usr/bin/ld --output /absolute/out/guardrail-release --plan

`--plan` validates the inputs without executing tools or writing output. Removing it builds and compares with recorded binary/package identities. `--record-new` is an explicit maintainer mode for a reviewed new source: it observes fresh successful compiler processes rather than requiring the historical binary hash. It never silently updates bundled files. Each successful target emits a `build-record.json` binding source, target, compiler hashes, process times/exit status/log digests, two output hashes, deterministic package hash and native smoke status. The maintainer must copy the actual generated outputs and records into the release, not change labels on old bytes.

Linux x64 uses the pinned `cc`; the pinned `ld` is an environment input, not an enforced compiler-driver search boundary. Linux ARM64 uses `--rust-lld /absolute/rust/lib/rustlib/x86_64-unknown-linux-gnu/bin/rust-lld` with self-contained linking. macOS ARM64 uses `--zig /absolute/zig/zig`, an isolated cache and minimum macOS 13. These are Linux x64 host recipes. Native development on other hosts uses Cargo directly.

## Three separate claims

1. Source integrity: `verifyGuardrailSource` compares the actual complete crate, source manifest, each target manifest and release provenance. In a source checkout `verify:guardrail` runs it automatically. Runtime packages intentionally omit Rust source.
2. Distribution integrity: `resolveGuardrail` checks the package-pinned index, source identity, target manifest, binary bytes/size/format, protocol, and pinned build records. This remains static and executes no binary.
3. Build observation: the records are produced by the build wrapper while it invokes and observes two builds. They are unsigned local process records, not cryptographic or independent supply-chain attestations. A malicious actor able to rewrite all source, records and hashes can forge a consistent history. A source-digest-only update to an old binary is not proof of rebuilding.

Only Linux x64 can execute natively on the cloud build host. ARM64 Linux and macOS native execution remains unrun; cross-build success and structural verification do not replace it. Per-target CI/native acceptance and installed-user-runtime verification must be reported separately. No CI run, signing, notarization or user-machine installation is implied.

After a source update, rerun Rust tests, regenerate the source manifest, actually rebuild every shipping target, update target manifests, build records, release provenance, release index and package pin, then run source/package/core-composition and real host engine tests. Preserve old failed build logs as failures, not receipts for successful output. The npm package excludes `crates/` and includes the already-built engines and process-record summary. Consumers never need Cargo for enrollment.
