; A bounded CL-like protocol. No CL runtime, user functions, mutation, or I/O.
(defprotocol coding-routine
  (:phase receive-request
   :produces request-context
   :next determine-changes)
  (:phase determine-changes
   :requires request-context
   :produces change-plan
   :next write-tests)
  (:phase write-tests
   :requires change-plan
   :produces test-spec
   :next verify-red)
  (:phase verify-red
   :requires test-spec
   :guard (and (fails-p test-spec)
               (not (syntax-error-p test-spec))
               (not (timeout-p test-spec)))
   :next implement
   :on-violation write-tests)
  (:phase implement
   :requires test-spec change-plan
   :produces patch
   :next verify-green)
  (:phase verify-green
   :requires patch test-spec
   :guard (and (passes-p test-spec patch)
               (eq (status patch) :applied))
   :next report
   :on-violation implement)
  (:phase report
   :requires patch test-spec
   :next :done))
