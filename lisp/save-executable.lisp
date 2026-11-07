;; Installation-only entry point. Never save an image containing user/session code.
(require :asdf)
(require :sb-introspect)
(load (merge-pathnames "runtime.fasl" (uiop:getenv "KIOKU_COMPILED")) :verbose nil :print nil)
(defun kioku-executable-main ()
  (setf sb-ext:*invoke-debugger-hook*
        (lambda (condition hook) (declare (ignore hook))
          (format *error-output* "~A~%" condition) (sb-ext:exit :code 70)))
  ;; ASDF paths and owner identity belong to this launch, not the build host.
  (asdf:initialize-source-registry '(:source-registry :ignore-inherited-configuration))
  (asdf:initialize-output-translations
   `(:output-translations (t ,(uiop:getenv "KIOKU_CACHE")) :ignore-inherited-configuration))
  (setf kioku.internal:*generation* (uiop:getenv "KIOKU_GENERATION"))
  (if (equal (rest sb-ext:*posix-argv*) '("--self-test"))
      (progn
        (assert (= 42 (gethash "x" (kioku.data:parse-json "{\"x\":42}"))))
        (assert (equal '(("a" "b")) (kioku.data:read-csv "a,b")))
        (assert (= 42 (funcall (compile nil '(lambda (x) (1+ x))) 41)))
        (write-line "KIOKU-EXECUTABLE/1"))
      (progn
        (unless (= (length sb-ext:*posix-argv*) 1) (error "UNEXPECTED_ARGUMENTS"))
        (kioku.internal:serve))))
(sb-ext:save-lisp-and-die (merge-pathnames "kiokuko-lisp" (uiop:getenv "KIOKU_CACHE"))
                        :executable t :save-runtime-options t :toplevel #'kioku-executable-main)
