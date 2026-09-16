(asdf:defsystem "kioku-runtime"
  :description "Bundled Kiokuko tools and their runtime dependencies"
  :depends-on ("yason" "cl-ppcre" "cl-csv")
  :components ((:file "tools")))
