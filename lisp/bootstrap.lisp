;; No user init, Quicklisp, or inherited ASDF configuration is loaded.
(require :asdf)
(require :sb-introspect)
(setf sb-ext:*invoke-debugger-hook*
      (lambda (condition hook)
        (declare (ignore hook))
        (format *error-output* "~&LISP_STARTUP_ERROR: ~A~%" condition)
        (finish-output *error-output*)
        (sb-ext:exit :code 70)))
(asdf:initialize-source-registry '(:source-registry :ignore-inherited-configuration))
(asdf:initialize-output-translations
 `(:output-translations (t ,(uiop:getenv "KIOKU_CACHE")) :ignore-inherited-configuration))
(let ((compiled (uiop:getenv "KIOKU_COMPILED")))
  (unless compiled (error "COMPILED_RUNTIME_MISSING"))
  (load (merge-pathnames "runtime.fasl" compiled) :verbose nil :print nil))
(kioku.internal:serve)
