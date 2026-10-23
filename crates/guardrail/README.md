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

## Evidence wire schema v2

This strict data format rejects schema 1, missing/duplicate/unknown fields, duplicate IDs, invalid digests and unknown enums. Values are never evaluated. Replace every `SHA256` below with the actual lowercase 64-character SHA-256 digest from the host original:

```lisp
(evidence :schema 2 :authority "kiokuko-dsh"
 :issuer "kiokuko-dsh:owned-execution:v1" :task "task-id" :revision 7
 :worker-generation "worker-3" :protocol-generation 11 :lease-generation 19
 :scope "scope-id"
 :collector (:version 1 :complete t :count 1 :unresolved 0 :digest "SHA256")
 :executions
 ((execution :id "operation-id" :scope "scope-id" :parent "evaluation-id"
   :sequence 1 :route :owned :kind :process :state :completed :outcome :failed
   :request "SHA256" :runtime "SHA256" :receipt "SHA256"
   :worker-generation "worker-3" :protocol-generation 11 :lease-generation 19))
 :source "SHA256" :tests "SHA256" :command "SHA256" :runtime "SHA256"
 :model-provider "none" :model-name "none"
 :model-parameters "SHA256" :transcript "SHA256"
 :artifacts
 ((test-spec :id "executor-receipt-id" :digest "SHA256"
   :worker-generation "worker-3" :protocol-generation 11 :lease-generation 19
   :source "SHA256" :tests "SHA256" :command "SHA256" :runtime "SHA256"
   :outcome :assertion-failure :exit 1 :assertions 3 :status :observed
   :provenance :execution-backed :supporting ("operation-id")
   :history () :state-digest "SHA256")))
```

The issuer remains a typed provenance label, not authentication. The Node adapter verifies host-owned structured observations and persisted original receipts before issuing this snapshot. Rust checks structure and bindings, not the external database or whether a caller telling it these facts is trusted. In particular, a native exit 0 or stdout digest is not Node assertion evidence.

The collector must be complete, with its count matching a contiguous, unique sequence of executions and zero unresolved operations. An empty execution list alone is not proof of pure evaluation. Execution routes are `native` or `owned`; kinds are `process` or `file`. States include `prepared`, `dispatching`, `running`, `completed`, `denied`, `cancelled-before-dispatch`, `cancelled-confirmed`, and `unknown`. Unresolved operations stay in the host journal but cannot issue a successful protocol snapshot. Operation outcome is separately `succeeded`, `failed`, or `none`, with state/outcome consistency required. The host verifies collector digest against saved originals; Rust only checks its digest syntax.

Worker generation is opaque text. Protocol-binding and lease-authority generations are separate positive integers. Supporting executions and artifacts must match each corresponding snapshot generation; those numbers are not compared with one another or with revision. All artifact source/test/command/runtime bindings match the captured top-level input digests. Names and opaque artifact IDs are unique.

Artifact provenance is one of:

- `execution-backed`: one or more existing completed, currently bound supporting operations. Test evidence requires an owned process with a compatible result. Multiple support references are allowed.
- `state-derived`: a produced artifact whose state digest matches current source. It has no invented supporting operation. A patch may have this provenance.
- `pure-evaluation`: a produced artifact with no support references and a host-complete zero-execution collector.

`history` references retain earlier operations without promoting them to success support. Failed history does not invalidate a later valid GREEN. A failed owned test with real assertion observations can support RED; unknown, denied or cancelled operations cannot support GREEN. There is no automatic `consumed`/`discarded` claim for arbitrary Lisp return values.

Artifact outcomes remain `assertion-failure`, `passed`, `syntax-error`, `timeout`, `setup-error`, `signaled`, `skipped`, `not-run`, `produced`; statuses remain `observed`, `applied`, `pending`, `completed`. Exit/outcome contradictions fail. Assertion failure requires exit 1–125 excluding 124, and `fails-p` requires actual failed assertions. `passes-p` requires a passed test with assertions, optionally paired with a produced/applied artifact. Syntax errors, timeout, signals, skips and non-runs do not unlock RED.

Queries remain `fails-p`, `passes-p` (one or two arguments), `syntax-error-p`, `timeout-p`, `skipped-p`, `exit-code`, `status`, and `assertions`. Model provider/name, parameters and transcript digests remain explicit. For no model call use `none` and the digest of the host-defined empty record. This engine is still a bounded protocol evaluator, not general SBCL: it adds no `defun` or `lambda` support, and cannot prove deterministic model inference or external effects.

## Build and package

Rust 1.85+; no third-party Rust crates, build scripts, or network dependency resolution. `cargo test --locked --offline`; `cargo build --release --locked --offline`. A release should pin the exact compiler distribution, target, source/lockfile hashes, command/flags, and `SOURCE_DATE_EPOCH`; capture compiler/archive checksums rather than trusting a mutable `stable` alias.

`scripts/package.py` packages an already compiled binary with the protocol, documentation, artifact hashes, source manifest and declared compiler/build inputs. It validates basic ELF64/Mach-O64 executable structure, segment bounds and architecture, normalizes tar metadata, and emits deterministic gzip bytes for the same inputs. Pass `--binary`, `--target`, `--output` (outside the source tree), and `--build-inputs` JSON with exactly `rustc_version`, `rustc_sha256`, `cargo_version`, `cargo_sha256`, `target`, `command` (array), and `source_date_epoch` (integer). Header inspection does not prove the selected Linux libc ABI; use the pinned target toolchain and native smoke test.

Release targets supported by packaging: Linux x86_64/aarch64 GNU or musl; macOS x86_64/aarch64. Windows is not in scope. This source tree alone does not mean all target binaries have been built or executed. Bundle only actually built, verified target artifacts in the plugin. Installation should select OS/architecture, verify manifest SHA-256 and executable permissions, and fail clearly if the target is absent; never silently run a different architecture or build/download unverified code at install time.

The test harness in `scripts/test.py` distinguishes compiler/setup failure (2), test assertion failure (1), and timeout (4), creates fresh temporary build state, and runs all compiled test executables. See `BOOTSTRAP.md` for the explicit API-scaffolding boundary. Common Lisp cycle journals are external development evidence, not runtime dependencies.
