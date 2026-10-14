# Bundled guardrail runtime notices

The Rust guardrail engine source is covered by the repository MIT license. Its precompiled binaries contain Rust standard-library code. COPYRIGHT-library.html is the unchanged notice bundle from the official Rust 1.99.0 distribution; COPYRIGHT-Rust.txt, LICENSE-MIT, LICENSE-APACHE and the accompanying license texts preserve upstream notices.

Linux artifacts use Rust-distributed static musl and unwinding/support components. musl-COPYRIGHT.txt and libunwind-LICENSE.txt are conservative supplemental upstream notices copied from the locally verified official Zig distribution. These two copies do not establish the exact revision linked by Rust. Zig itself was used only as a macOS cross-build tool and is not a plugin runtime dependency.

manifest.json records the copied notice hashes. The repository source and recorded toolchain/component provenance live under crates/guardrail and crates/guardrail-release; those build inputs are deliberately excluded from the npm runtime package. These runtime notices remain in both the full and core/composed packages.
