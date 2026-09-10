# Execution and model selection

For each new build, debug, review or devops task, including README edits, choose
**normal execution** or **役小角(enno-oduno)** in the native DSH question cards.
An explicit instruction such as “without enno-oduno” avoids a duplicate mode
question. Chat and existing non-Enno research/writing tasks keep their ordinary
flow. Continuations, retries and replanning retain the logical task's choice.
Cancel or skip preserves the request and draft configuration for resumption.

Normal execution uses the current DSH model, memory, applicable Skills, native
permissions and focused verification. It creates no Enno contract, WorkUnit,
plan approval or automatic Enno continuation.

On selection cards, type an option number and press Enter to submit. For options
above nine, type consecutive digits (`1`, `2`, Enter selects option 12); Backspace
corrects the number. Digits typed in the search field remain search text, and Enter
submits the search. IME composition and repeated key events do not select or submit.

Enno offers eight versioned templates across **OpenAI, OpenCode Go, OpenCode Zen,
OpenRouter and Ollama**, plus a custom configured-model selector. The complete
[template table and configuration reference](model-selection.ja.md) lists exact
model IDs. OpenAI assigns Astra to ideal/Zenki/check, Sol to the Goki head and
Luna to workers. Go and OpenRouter provide GLM and Qwen variants; Zen uses GLM.
Ollama uses `qwen3-coder:30b` for every role, limits children to one, and never
downloads models. Reasoning uses model defaults; reflection uses the check model.

For [dsh-codex](https://github.com/askdkc/dsh-codex), choose **OpenAI Codex・推奨（dsh-codex）**
from the template menu, then confirm the configuration. It assigns Astra to
ideal/planning/check, Sol to the Goki head and Luna to workers, following the
[OpenAI model guide](https://developers.openai.com/api/docs/models). This is a
quality/workload recommendation, not a measured per-task latency or quota optimum.
The plugin-specific template binds the exact `openai-codex` / `codex` / `responses`
contract from [dsh-codex's implementation](https://github.com/askdkc/dsh-codex/blob/e2e61b6d8f3b511cf2dac99688e97b8728cb122c/src/index.ts)
without asking for the connection again. Conflicting `modelRoutes` declarations
remain untouched. Recommended models must exist in the current DSH catalog;
missing models leave roles unset and prevent starting. The catalog is rechecked
immediately before adoption.

Bind generic templates to actual configured DSH providers; route IDs are not assumed.
Distinguish OpenAI API from Codex authentication and Go from Zen. The selector
supports provider/model search, pagination, copying roles, editing, back and
cancel. Exact IDs or declared aliases resolve models; similar display names
never authorize substitutions. Edited templates are custom but retain their
original template ID/version. Configuration confirmation shows every role's
provider and model. Provider-catalog failure, missing routes/models and required
compatibility verification have distinct presentations.
Unset roles start with enno-ideal's provider and go straight to model selection;
editing an assigned role keeps its own provider. Use “接続を変更” (change connection)
on the model card to choose another provider. If the preferred provider is unset
or no longer registered, the selector opens the provider list.
Use “検索をクリア” to clear an empty search and “一覧を再取得” to retry a failed list.
Free-text digits remain search terms. Back in route declaration returns to the
previous step. Confirmed models survive route cancellation; “接続設定を確認” resumes
unfinished declarations or corrects draft connection settings without reselecting models.

Optional plugin `modelRoutes` entries declare `provider`, `family`, `connection`
and `protocol`; the native cards can also bind previously unclassified routes.
These declarations do not change DSH authentication and do not prove a successful
wire request. Astra requires a Responses declaration. An incorrect declaration
can still fail at runtime. Authentication, quota and unavailable-model failures
retain completed work and require reselection rather than automatic fallback.

**Go remains pending on the standard 0.1.2-rc.1 pi-ai Chat Completions route.**
A recording HTTP fixture with the actual adapter observes no
`x-deepseek-harness-session-id` for parent, child or auxiliary calls. Custom
selection applies the same compatibility check and does not switch to Zen.
A host managing a separately verified adapter may supply the optional
`dshModelCompatibility.inspect(binding, route)` service with protocol and Go
parent/child/auxiliary header evidence. DSH does not supply this plugin-specific
extension by default, and a user-question answer cannot mark transport verified.

Resolved configuration and the ordinary model are persisted per logical run.
Template updates do not rewrite active tasks. Agent-scoped assembly/request hooks
freeze one selection per request and restore ordinary routing at completion;
the Web `selectModel()` command and deployment defaults are not changed.

`enno_delegate` accepts an `instruction` for the current approved WorkUnit. The
host validates the lease, chooses the approved worker model and uses native
in-process `spawn`. Children are bound before their first request and cannot
restart intake, delegate or report parent acceptance. Initially workers use
scoped file tools; Goki runs commands and focused verifiers and then reports with
`enno_work_report`. Child completion is evidence, not WorkUnit acceptance.
Interrupted delegations remain uncertain rather than being automatically replayed.
Child concurrency is counted from durable state across restarts. Each child request
and file operation rechecks the current lease. A hard process exit can leave a
delegation marked as running; inspect its native child evidence before additional
delegation. Restarting does not erase that reservation.

Native tests cover request model IDs, ordinary README completion, cancel/reload,
input recovery, independent sessions, routing restoration and actual adapter
transport. Recording adapters do not verify paid account access, subscription
limits or successful live provider responses. Existing advisors, leases, final
verification, memory finalization and Orca behavior remain in place.
