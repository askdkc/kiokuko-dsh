# Semantic retrieval

軽量インストールではlexical検索が動きます。semantic検索は任意のruntime
capabilityですが、DSH packageは汎用の`kiokuko embeddings setup`、`status`、
`repair` commandを公開しません。

DSH pluginの公開package boundaryは`./dsh` entrypointに限定されています。
汎用Kiokuko clientのinstallや設定も行いません。optional embeddingの詳細は
DSH runtimeとverification reportの契約であり、実行可能なpackage CLIの契約
ではありません。
