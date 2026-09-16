;; Only the host launches this entry point, before accepting any model code.
(require :asdf)
(require :sb-introspect)
(declaim (optimize (speed 1) (safety 3) (debug 1)))
(let* ((root (uiop:pathname-directory-pathname *load-truename*))
       (cache (uiop:getenv "KIOKU_CACHE")))
  (asdf:initialize-source-registry
   `(:source-registry (:directory ,root) (:tree ,(merge-pathnames "vendor/" root))
     :ignore-inherited-configuration))
  (asdf:initialize-output-translations
   `(:output-translations (t ,cache) :ignore-inherited-configuration))
  (let ((*compile-verbose* nil) (*load-verbose* nil))
    (asdf:operate 'asdf:monolithic-compile-bundle-op "kioku-runtime"))
  (uiop:copy-file
   (first (asdf:output-files 'asdf:monolithic-compile-bundle-op "kioku-runtime"))
   (merge-pathnames "runtime.fasl" cache)))
