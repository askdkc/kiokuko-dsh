;; Probe the actual SBCL behind a configured launcher, without user init files.
(require :asdf)
(let ((*print-pretty* nil))
 (format t "KIOKU-RUNTIME/1~%~A~%~A~%~A~%~A~%~A~%~A~%~S~%"
        (lisp-implementation-version) (machine-type) (software-version)
        (asdf:asdf-version) (namestring sb-ext:*runtime-pathname*)
        (namestring sb-ext:*core-pathname*)
        (sort (mapcar #'symbol-name *features*) #'string<)))
