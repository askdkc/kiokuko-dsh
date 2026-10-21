# Bounded live condition/restart recovery

`kioku.recovery:select-restart` is opt-in recovery inside an explicit Common Lisp
`handler-bind`. The handler runs before unwinding, so the named restart keeps its
lexical state. The host sends only the supplied JSON context, condition type and
1–8 descriptions to the configured typed-decision provider. It never sends an
arbitrary stack dump. The provider selects an offered opaque ID or abstains; it
cannot supply code or restart arguments.

```lisp
(let ((local 41))
  (handler-bind
      ((simple-error
         (lambda (condition)
           (kioku.recovery:select-restart
             condition (kioku.internal:object "local" local)
             '((use-local "Use the captured local value plus one")
               (discard "Return -1 without repeating preceding work"))
             :timeout-ms 10000))))
    (restart-case (error "Synthetic missing value")
      (use-local () (+ local 1))
      (discard () -1))))
```

The normal `lisp_eval` result and operation journal contain the resumed result.
The host requires current Working task authority before dispatch and again before
returning the selection. Existing generation, owner and cancellation checks also
apply. Pending Lisp effects in this session, unresolved owned operations in the
current task, or managed running jobs reject selection both before and after the
model call (`RECOVERY_UNCERTAIN`). This uses host records, not model claims. Persistent development/protected workers support this API. Disposable
development workers use the same bridge; protected task workers continue denying
RPC. A missing decision provider or authentication fails without substitution.
`lisp_describe` advertises the API; no additional native tool is required.

A ticket is bound to worker generation and evaluation, claimed synchronously once,
and consumed even on failure. There are at most four selections per evaluation.
Each selection has a 100–30000 ms deadline (default 10000 ms), within the existing
overall evaluation deadline. Duplicate tickets, malformed/old IDs, multiple
answers, abstention, provider errors and late answers cannot invoke a restart.
Selection timeout returns an ordinary failed evaluation without losing the worker;
evaluation timeout, cancellation or worker death retain the existing UNKNOWN and
human recovery behavior. Worker replacement still loses heap/refs. Nothing is
replayed, reconstructed or resumed after replacement.

Only offer zero-argument continuations whose effects are appropriate. This is not
a verifier of arbitrary restart bodies: Lisp code can itself perform effects.
Never offer a retry of an effect whose outcome is UNKNOWN, and inspect the original
receipt instead. Existing effect boundaries still authorize every subsequent host
effect. Unhandled conditions keep the existing failed-result behavior.

## Safety budgets

Eight offered continuations plus abstention keep one choice narrow and fit the
existing TypeSafe/Nimble choice capabilities. Four consumed attempts bound a
repeated condition loop. A 30-second ceiling bounds held stack time and provider
latency; four full choices cannot extend the existing default 120-second overall
evaluation deadline. Shorter configured evaluation/provider deadlines still win.
The 100 ms lower bound matches the existing evaluation timing floor. These are
conservative resource policy limits, not empirically optimal quality settings,
and do not test or pin a provider version. Capability/shape validation remains the
compatibility contract. Tests exercise 0/1/8/9 choices, 99/100/30000/30001 ms,
and four accepted/fifth refused attempts, including consumed failures.

## Verification and model measurement

The existing Lisp suite discovers `unit/lisp/recovery.test.ts` and
`integration/lisp/recovery-runtime.test.ts`; no CI job was added. The latter
exercises real SBCL in development and protected modes, lexical state, one preceding
synthetic effect, replay, abstention, stale answers, provider failure, selection and
evaluation deadlines, cancellation, worker death, generation replacement and task
revocation. Unit tests also cover concurrent double selection and budget bounds.

Run the opt-in synthetic model comparison with the current saved default route:

```sh
node --import tsx scripts/run-lisp-recovery-evaluation.mjs --live \
  --profile /path/to/existing/dsh/profile --output /tmp/lisp-recovery-report.json
```

It uses the existing Models service/adapter and ordinary credential reads. Writes,
OAuth refresh, configuration learning and route discovery are denied by read-only
wrappers; configuration/credential bytes are compared before and after. No user
DB or current process is used. Twenty requests maximum, 256 output tokens each,
30 seconds per request, ten minutes overall, with no retry/substitution. Synthetic
recovery and finite prototype-choice tasks each have five interleaved trials per
arm. Results separate execution, choice appropriateness, unknown-effect stopping,
duplicate counters, full prototype result inspection and latency.

This harness injects its normal-model adapter into `decisionCall`; it does not
establish deployed typed-provider authentication, native UI integration or autonomous
tool-use quality. Prototype steps are scripted rather than chosen by the model.
Finite counters do not prove absence of duplicate arbitrary external effects.
Small easy synthetic tasks cannot establish general quality or product superiority.

The public Typed Decisions path can also be measured with existing TypeSafe
configuration and ordinary DSH credential resolution, without setting a key:

```sh
node --import tsx scripts/run-lisp-typed-recovery-evaluation.mjs --live \
  --profile /path/to/existing/dsh/profile --output /tmp/lisp-typed-report.json
```

This performs at most five synthetic requests using `DecisionService` and the
shipped TypeSafe request/response contract. It uses profile settings or their
shipped default; persisted user-DB decision selections are not read or changed.
It establishes the product's manager/worker/decision-provider connection under the
fixture host, not an installed native UI session. Current measured results and
source identities are in [the verification record](lisp-recovery-verification.md).
