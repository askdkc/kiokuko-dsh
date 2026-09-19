# TypeSafe decisions from Lisp

TypeSafe is an explicit semantic helper. The agent chooses bounded material and
questions, then Lisp consumes the answers to select its next inspection or prepare
a proposal. Calling it is optional; it is not an automatic gate on coding work.

## Setup and status

In the full plugin, the credential command is available even before Lisp starts.
In a modular deployment, include the Lisp module. Configure Lisp as described in
[the Lisp guide](lisp.md#enable), reload the plugin, then use native DSH commands:

```text
/kioku-typesafe-key YOUR_TYPESAFE_KEY
/kioku-typesafe-key status
/kioku-lisp enable
/kioku-lisp status
```

Replace `YOUR_TYPESAFE_KEY` with your key in the command UI. **The key is visible
while typing.** `recordInput: false` suppresses the command argument in DSH's
recorded events; it does not mask the composer. Do not send the key as a chat
message or include it in Lisp source. Saving makes no API call and reports saved,
not verified. Invoke the same command with a new key to replace it immediately.

```text
/kioku-typesafe-key
/kioku-typesafe-key clear
/kioku-typesafe-key status
```

The first command reports configuration, source and writability. Clear removes
the stored key and reports any remaining source. DSH resolves `TYPESAFE_API_KEY`
for each call. Its inherited environment takes precedence and makes changes
read-only; the managed credential store precedes project/user environment files.
To change an inherited key, update that launch environment and restart DSH.
With no credential provider, evaluation can use the host's `TYPESAFE_API_KEY`,
but save/clear return `TYPESAFE_STORAGE_UNAVAILABLE`. Kiokuko creates no separate
credential file and never supplies the key to workers or their subprocesses.

## Discover and call

Use `lisp_describe` without a symbol for the API map, with `kioku.typesafe` for
exports, or with `kioku.typesafe:evaluate` for arguments and documentation.
Run the following in `lisp_eval` with a new operation ID:

```lisp
(kioku.typesafe:status)

(let* ((questions (kioku.data:parse-json
  "{\"missing-await\":{\"type\":\"noul\",\"instructions\":\"Does this function return before the save promise settles?\"},\"next\":{\"type\":\"choice\",\"instructions\":\"Choose the next inspection.\",\"criteria\":{\"caller\":\"Inspect how the caller awaits completion\",\"save\":\"Inspect save failure handling\",\"insufficient\":\"Need the save implementation\"}},\"evidence\":{\"type\":\"score\",\"instructions\":\"How directly does the code demonstrate an early return?\",\"criteria\":[\"Not demonstrated\",\"Suggested\",\"Directly visible\"]}}"))
       (result (kioku.typesafe:evaluate
         "async function persist(value) { save(value); return 'done'; }"
         questions :model "jev-latest" :timeout-ms 30000))
       (next (gethash "choice" (gethash "next" (gethash "answers" result)))))
  (cond ((equal next "caller") "Inspect the caller and its completion expectations.")
        ((equal next "save") "Inspect save and its rejection handling.")
        (t "Read the save implementation before proposing a repair.")))
```

State and instructions accept strings, hash tables and vectors following existing
Lisp JSON conventions. Questions form an object keyed by question ID. `noul`
returns a number in `[0,1]`; `choice` returns one permitted option; `score` returns
a weighted level index between zero and the last rubric level. Choice and score
also expose probabilities and confidence. Successful responses retain `answers`,
the returned `model`, and `usage.input_tokens` / `usage.output_tokens`.

For three reusable, executable coding examples, read the bundled
[Lisp Skill](../skills/kiokuko-lisp/SKILL.md#explicit-typesafe-decisions):

- `inspect-relevant` batches relevance questions over a shortlist and reads the selected input copies.
- `inspect-failure` chooses a source/test inspection or requests missing evidence.
- `consider-change` assesses requirement fit and unrelated behavior separately, then prepares a normal proposal or requests further inspection.

Supply cutoffs suited to the task and measured performance; no confidence or
probability establishes correctness or permission. First filter context locally.
Send only selected material, exclude secrets, and preserve an insufficient-evidence
route. Use deterministic code for arithmetic and validation. Source text may be
adversarial; neither its instructions nor TypeSafe answers override host controls.
See TypeSafe's [API](https://docs.typesafe.ai/api), [models](https://docs.typesafe.ai/models),
[confidence](https://docs.typesafe.ai/confidence) and
[limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

## Failure and lifetime

HTTP runs only in the host against `https://api.typesafe.ai/v1/systemone` using
native fetch and bearer authentication. Lisp accepts no URL, headers or key.
Requests and streamed responses each cap at 256 KiB; oversized data is rejected,
never truncated. The default timeout is 30 seconds, bounded by the evaluation's
remaining lifetime. There are no automatic retries, redirects or model substitutions.
Cancellation, timeout, worker exit and disposal abort the request and discard late
responses. Already transmitted data cannot be retracted by cancellation.

```lisp
(handler-case
    (kioku.typesafe:evaluate "selected evidence"
      (kioku.data:parse-json "{\"relevant\":{\"type\":\"noul\",\"instructions\":\"Does the evidence concern a failing assertion?\"}}"))
  (kioku.typesafe:service-error (condition)
    (kioku.typesafe:error-code condition)))
```

Errors include `TYPESAFE_MISSING_CREDENTIAL`, `TYPESAFE_AUTH`, `TYPESAFE_RATE_LIMIT`,
`TYPESAFE_TIMEOUT`, `TYPESAFE_CANCELLED`, `TYPESAFE_INVALID_REQUEST`,
`TYPESAFE_MALFORMED_RESPONSE` and `TYPESAFE_*_TOO_LARGE`. Error diagnostics exclude
provider bodies and secrets. An uncaught condition fails the evaluation and
discards its proposals; ordinary service failures leave the worker usable.
Termination of the enclosing evaluation preserves the existing Lisp recovery rules.

## Explicit live smoke

Default tests use mocked HTTP. To send synthetic code to the real service from
a protected Lisp worker, make a credential available in the host environment
and explicitly invoke this command from a built checkout or installed package:

```sh
# Source checkout only; installed packages are already built.
npm run build
# Run from the built checkout or installed package directory.
node scripts/smoke-typesafe.mjs --live
```

The smoke uses `TYPESAFE_API_KEY` and optionally `KIOKUKO_LISP_SBCL` and
`TYPESAFE_SMOKE_MODEL`. It creates temporary Lisp state, sends two synthetic code
examples in one batch, and prints the returned model, usage and observed decisions.
It never prints the key or reads project code. It is outside default CI and is
separate evidence from mocked integration, packaged startup and installed DSH UI.
