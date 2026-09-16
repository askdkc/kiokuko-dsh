;; Verify a candidate bundle in a fresh image before the host publishes it.
(require :asdf)
(require :sb-introspect)
(load (merge-pathnames "runtime.fasl" (uiop:getenv "KIOKU_CACHE")) :verbose nil :print nil)
(assert (compiled-function-p #'kioku.internal:serve))
(assert (equal '(("a" "b")) (kioku.data:read-csv "a,b")))
(assert (= 42 (gethash "x" (kioku.data:parse-json "{\"x\":42}"))))
