# kiokuko-guardrail

A dependency-free Rust engine for a **bounded CL-like declarative protocol language**, not a Common Lisp implementation. The pure reader, evaluator, and transition model do not perform file, process, network, clock, model, or output operations. The CLI is a separate I/O boundary. Input paths must be regular files, with final-component symlinks rejected; Linux/macOS opens use nonblocking/no-follow flags and descriptor checks so an unwritten FIFO is rejected promptly. This is not a claim that arbitrary filesystem I/O can never stall.

## Boundary and authority

- `HostQuery` is a trusted, read-only evidence adapter. Only explicitly registered query names and arities can be called. The Rust trait uses `&self`; Rust cannot prove that an adapter has no interior/external side effects, cannot preempt a blocked callback, and cannot certify the truth of its result. Adapters must return bounded captured data and enforce their own timeout.
- The production adapter must read actual receipts/artifacts from kiokuko-dsh's existing SQLite authority. It must not accept AI/model self-reported test results or an arbitrary caller-supplied evidence file as authority. This module never creates a second persistent five-state task store.
- `check_phase` and the `check` CLI compute a decision from a snapshot. A decision grants no OS permissions. The existing effect interpreter must check task/revision/generation, source/test/command/runtime bindings and current authority state immediately before applying an effect. The check-to-effect race remains the host's responsibility.
- The standalone pure `RunState` is an optional protocol interpreter. It is not the product task authority. It stamps outputs with phase-entry/generation tokens, rejects stale entries and protocol replacements, and invalidates a revisited phase's outputs plus all transitive dependents. Its phase-entry counter is scoped to one in-memory run, not a globally unique task identifier; cross-run/task replay prevention must use the existing host authority’s task and revision binding. It is not protection against a malicious caller modifying public Rust values or forging a whole snapshot.
- SHA-256 records identity and ordinary integrity, not authenticity. No signatures, tamper-proof journal, kernel sandbox, or global enforcement are claimed.

## Language

Symbols/keywords use ASCII lowercase normalization; strings preserve Unicode and case. Identifiers are ASCII alphanumeric plus `-+*/<>=!?_.$%&~^`, with keywords introduced by `:`. Integers are signed i64. Dotted lists, packages, escapes in symbols, reader dispatch macros, backquote, comma, and arbitrary CL reader extensions are rejected. Strings support `\\`, `\"`, `\n`, `\r`, and `\t`. Semicolon comments run to end of line.

Supported forms: `and`, `or`, `not`, `null`, `if`, `when`, `unless`, `=`, `<`, `>`, `<=`, `>=`, `eq`, `equal`, `quote`/`'`, `car`, `cdr`, `cons`, `list`, and explicitly registered host queries.

`and`/`or` short-circuit and return operand values. `if` has exactly three operands; `when`/`unless` evaluate a sequence only when selected. Numeric comparisons take exactly two integer operands. Proper lists only: `cons` requires a proper-list tail. `car`/`cdr` of nil return nil. `nil`, `()`, an empty host list, and host `Bool(false)` normalize to nil; `Bool(true)` becomes symbol `t`. Only nil is false after normalization; zero and the empty string are true. Quoted symbols are real `Value::Symbol` values. `equal` is structural; `eq` compares atoms (including opaque handles) and is false for nonempty lists. There is no heap-identity claim.

Unknown forms always produce `UnsupportedForm`; they never fall through to an unrestricted host call. Guards are validated in full before evaluation, so unsupported forms and invalid arity in a dead branch also fail. Quoted forms are inert data. `defun`, `defmacro`, `lambda`, `setq`, `setf`, `let`, `loop`, `dolist`, `dotimes`, `eval`, `read`, `load`, output operations, and other non-whitelisted forms are rejected.

Default limits: 256 KiB input, depth 64, 16,384 syntax nodes, 100,000 evaluation steps, 16,384 nodes per normalized value, 1,024 host calls. Aggregate manually supplied AST text and cumulative normalized-value text/handle allocations also share the input-byte budget, so repeated host strings cannot multiply it without limit. Callers can lower budgets; hard ceilings remain at 1 MiB input, depth 128, 65,536 nodes/value nodes, 1,000,000 steps, and 4,096 host calls. A resource-limit error is distinct from a false guard and from a parser error. Limits bound the engine's work, not an arbitrary host callback's wall time.

## Protocol declarations

See `examples/coding-routine.lisp`. Exactly one `defprotocol` contains 1–128 named phases. Each phase declares `:requires`, `:produces`, `:guard`, `:next`, and optionally `:on-violation`. `:requires`/`:produces` take one or more bare artifact names. Every phase needs a `:next` phase or `:done`. Every unquoted artifact reference in a guard must be named in `:requires`; quoted symbols and operators do not create artifact dependencies. There is one producer per artifact; duplicate fields/names, unknown links, missing producers, and unsupported guards fail closed. The sample expressly excludes timeout and syntax-error outcomes from RED.

## CLI

- `kiokuko-guardrail --version`
- `kiokuko-guardrail read FILE`
- `kiokuko-guardrail eval '(and (= 1 1) :ok)'`
- `kiokuko-guardrail validate PROTOCOL_FILE`
- `kiokuko-guardrail check PROTOCOL_FILE PHASE EVIDENCE_FILE`

`check` emits one stable S-expression with allow/deny, next phase, task, issuer and authority revision, canonical protocol SHA-256, exact evidence-file SHA-256, package version, and the current executable SHA-256. Captured identical inputs and the same engine binary produce the same output across process restarts. Exit 0 = allowed/success; 3 = valid evidence but guard false; 2 = malformed input, invalid bindings, unsupported form, or other error; 4 = resource limit. A process/setup error never counts as assertion RED.

## Evidence wire schema v1

This is a strict data format: fields are required, duplicate/unknown fields rejected, values are never evaluated. Example digests below must be replaced by actual lowercase 64-character SHA-256 values:

```lisp
(evidence :schema 1 :authority "kiokuko-dsh"
 :issuer "kiokuko-dsh:owned-execution:v1" :task "task-id" :revision 7
 :source "SHA256" :tests "SHA256" :command "SHA256" :runtime "SHA256"
 :model-provider "none" :model-name "none"
 :model-parameters "SHA256" :transcript "SHA256"
 :artifacts
 ((test-spec :id "executor-receipt-id" :digest "SHA256"
   :generation 3 :expected-generation 3
   :source "SHA256" :tests "SHA256" :command "SHA256" :runtime "SHA256"
   :outcome :assertion-failure :exit 1 :assertions 3 :status :observed)))
```

The required issuer is `kiokuko-dsh:owned-execution:v1`; this string is only a typed provenance label. The product adapter must verify the actual host-only observation witness and receipt identity in the existing authority before creating a snapshot. The engine does not authenticate a caller merely because it writes that string. All artifact bindings must match top-level captured inputs. Generation is positive, matches the authority-provided expected generation, and does not exceed the snapshot revision. Artifact names and opaque IDs are unique. Supported outcomes: `assertion-failure`, `passed`, `syntax-error`, `timeout`, `setup-error`, `signaled`, `skipped`, `not-run`, `produced`. Status: `observed`, `applied`, `pending`, `completed`. Exit/outcome contradictions fail. Assertion failure requires a normal nonzero exit (1–125 excluding timeout convention 124); `fails-p` additionally requires at least one actual failed assertion. `passes-p` requires a passed receipt with assertions; its optional second argument must be a produced, applied artifact. Syntax errors, timeouts, signals, missing executables, skips, and non-runs cannot unlock RED.

Built-in snapshot queries: `fails-p`, `passes-p` (1–2 arguments), `syntax-error-p`, `timeout-p`, `skipped-p`, `exit-code`, `status`, `assertions` (the others take one opaque handle). Snapshot fields express what the trusted adapter captured; their presence does not prove execution or establish caller authorization.

Model provider/name, model parameters digest, and captured transcript digest are explicit inputs. For no model call, use `none` and a digest of an explicitly defined empty record. Protocol/evidence evaluation is deterministic; live model inference, networks, tools, external state, and model providers are not claimed deterministic. Identical recipes across operating systems do not imply bit-identical platform executables or identical external effects.

## Build and package

Rust 1.85+; no third-party Rust crates, build scripts, or network dependency resolution. `cargo test --locked --offline`; `cargo build --release --locked --offline`. A release should pin the exact compiler distribution, target, source/lockfile hashes, command/flags, and `SOURCE_DATE_EPOCH`; capture compiler/archive checksums rather than trusting a mutable `stable` alias.

`scripts/package.py` packages an already compiled binary with the protocol, documentation, artifact hashes, source manifest and declared compiler/build inputs. It validates basic ELF64/Mach-O64 executable structure, segment bounds and architecture, normalizes tar metadata, and emits deterministic gzip bytes for the same inputs. Pass `--binary`, `--target`, `--output` (outside the source tree), and `--build-inputs` JSON with exactly `rustc_version`, `rustc_sha256`, `cargo_version`, `cargo_sha256`, `target`, `command` (array), and `source_date_epoch` (integer). Header inspection does not prove the selected Linux libc ABI; use the pinned target toolchain and native smoke test.

Release targets supported by packaging: Linux x86_64/aarch64 GNU or musl; macOS x86_64/aarch64. Windows is not in scope. This source tree alone does not mean all target binaries have been built or executed. Bundle only actually built, verified target artifacts in the plugin. Installation should select OS/architecture, verify manifest SHA-256 and executable permissions, and fail clearly if the target is absent; never silently run a different architecture or build/download unverified code at install time.

The test harness in `scripts/test.py` distinguishes compiler/setup failure (2), test assertion failure (1), and timeout (4), creates fresh temporary build state, and runs all compiled test executables. See `BOOTSTRAP.md` for the explicit API-scaffolding boundary. Common Lisp cycle journals are external development evidence, not runtime dependencies.
