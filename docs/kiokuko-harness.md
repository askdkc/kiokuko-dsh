# Kiokuko-owned harness

This unreleased source build replaces DSH's agent factory through a plugin. It does not modify DSH core or dsh-cli. The bundle disables `agent-loop` and installs `kiokuko-dsh/harness`; do not enable both factories in one profile.

## Configuration

Build the package, then install the resulting local tarball into an isolated profile:

```sh
npm ci --ignore-scripts
npm run build
npm pack --ignore-scripts
dsh plugin --profile dsh-cli add ./kiokuko-dsh-0.2.39.tgz --ignore-scripts
dsh --profile dsh-cli --dump-config
dsh-cli
```

The profile must already supply DSH and the CLI's required peer services. DSH delegates plugin installation to pnpm; adding a tarball with npm to an existing dsh-cli dependency tree can reject the CLI's bundled `workspace:*` dependencies. Keep the host dependency graph coherent. Do not disable compatibility checks or relax permissions to repair a missing peer package.

The resolved configuration must have one enabled `kiokuko-dsh/harness` and a disabled `agent-loop`. Harness options are provider/model defaults and an explicit step budget:

```yaml
- id: kiokuko-harness
  config:
    maxSteps: 128
```

Reaching the budget records a failed turn for inspection; it does not assert task success. Set a suitable budget for longer work. Tool authority still belongs to the native tool scope and approvals.

For the previous plugin integration, pass the installed overlay **after** the bundle:

```sh
dsh --profile dsh-cli --patch /absolute/install/path/kiokuko-dsh/dsh/cordis.legacy.patch.yml
```

It disables the Kiokuko factory, enables the standard factory, and removes the main plugin's replacement-factory dependency. The default bundle still selects the replacement. With a supporting CLI, `dsh-cli --ignore-kiokuko` excludes Kiokuko for that launch and restores the other bundles' configuration. A profile containing only DSH and dsh-cli remains independent of Kiokuko.

## Runtime contracts

`AgentFactory.createAgent` and `resume` publish agents only after scoped setup. The registry, session storage, model adapters, system prompt assembly, tool execution and UI remain native DSH services. Kiokuko owns the inbox, turn/step scheduling, direct intake and continuation callbacks. Public pre-step, turn-stopping and idle notifications remain available to other plugins; the standard AgentLoop is not required to drive them.

`followup` wakes the next turn; `steer` wakes the next step; `inject` queues context without waking an idle agent. Rejected intake retains its request and parks until another wake, rather than consuming it or spinning. Cancellation preserves a streamed prefix, closes the turn and leaves subsequent input usable. Resume reads the persisted session, closes interrupted turns with native recovery records and does not automatically repeat past tool effects. This does not provide exactly-once effects after an unacknowledged external operation: inspect its receipt before retrying.

Parent and child agents use the same factory and native scope inheritance. A separately scheduled turn clears the caller's ambient task lease and resolves its own authority at tool admission. A child restricted by the native tools service cannot execute a denied tool through this driver.

Lisp function definition, composition, invocation and workspace observation do not require switching to task mode or creating a Working task. Only the caller's own protected worker may be reused; development workers and other owners' heaps are never borrowed. Other calls use protected scratch without a repository mount or host RPC. Arbitrary Lisp is not certified pure by a JSON schema. Shared publication, file changes and external commands retain their existing task/approval/receipt boundaries. A child with an exact live native owner inherits only Lisp capabilities its native scope already exposes, with separate results and scratch execution. There is no worker handoff layer. Real SBCL behavior remains an explicit environment-dependent acceptance check.

## Memory and improvement

Native repository learning consumes the canonical turn observations, emits hypotheses with source references, persists the compact projection and supplies it to later requests as untrusted reference data. A terminal `completed` event means the turn ended, not that the task was independently verified. Re-check hypotheses against current files. Root discovery matches the runtime registration even when launched from a repository subdirectory.

Optional retrieval, validation or reflection failures leave ordinary permitted work usable. Diagnostics distinguish saved, not saved and unknown acknowledgement. Existing pending admissions support repository-learning recovery after reload; exact approved curated-memory candidates retain their original save identity for retry. Neither path reruns the original task. Capture refusal, exclusion, stale authority and actual operation approvals remain enforced. Curated replay-memory proposals still require the native question and approval of the exact preview revision.

The improvement loop is recorded outcome → bounded reflection → evidence-linked hypothesis → later retrieval and current-source verification. It does not rewrite production code or infer approval from logs. The live assistant acceptance has exercised generation, persisted hypothesis retrieval after process restart, and re-reading the current input before using the recalled suggestion.

## Logs and limits

| Path | Evidence retained | Limits |
| --- | --- | --- |
| Inbox and lifecycle | Native session commands, turn/step boundaries, harness action metadata | Host/process death can leave a final boundary pending until resume |
| Model stream | Native assistant stream, committed message or interrupted attempt, error/cancel/retry metadata | Provider internals and activity outside this driver are not observable |
| Tool execution | Native call/result IDs, harness start/result/error/cancel metadata; flush before effect | A crash between effect and receipt leaves an uncertain external outcome |
| Parent/child | Native ownership, session parent identity and call/turn correlation; child capability filters are preserved | Detached external agents and real SBCL child execution remain unverified |
| AgenticReplay | Existing model/tool hooks plus bounded harness metadata when recording is enabled and the session is bound | Early unbound lifecycle records remain only in the canonical DSH session; recorder completion is not task success |
| Memory | Capture/retrieval diagnostics, source references, reflection status, saved revision | Unavailable stores cannot be described as saved; optional generation is not a permission grant |

Harness metadata contains no copied tool arguments or model bodies. AgenticReplay retains its existing redaction and metadata modes. DSH's canonical conversation persistence remains DSH's own content contract; this change does not retrofit redaction into old sessions. Do not put API keys into prompts or tool arguments.

Cloud checks exercised DSH `0.2.1-rc.5`, dsh-cli `0.14.18`, Node `24.19.0` and pnpm `11.25.0`, plus unit contracts against the repository's declared development dependencies. These identify tested artifacts, not a version-number compatibility fence. Scripted providers test wire contracts; live assistant-in-loop transport uses fresh decisions by the executing assistant and is not an authenticated external provider API session.

SBCL is required for real Lisp execution. It was absent in this cloud runtime and its configured OS package source returned HTTP 403. Manager/transport contracts and a real DSH child read/scope test passed without SBCL; these are not Lisp execution or OS isolation proof. Real SBCL tests now include resident composition, preserved parent state, child scratch, restart and reader-time write refusal, but still require execution on a supported host. Deep native planning contracts (24 cases) ran against the replacement factory with scripted adapters. External provider authentication and the actual browser UI remain unverified. No complete-compatibility claim follows from these checks.
