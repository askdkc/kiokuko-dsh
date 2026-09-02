# Legacy core CLI contract

この文書はKiokuko core CLIの実装契約です。`kiokuko-dsh`の公開パッケージは
汎用CLIを配布せず、DeepSeek Harnessの`./dsh` entrypointだけを公開します。
以下の`kiokuko`コマンドは、このPluginの導入後に利用できるコマンドではありません。

After npm publication, the default global installation is intentionally lightweight:

```bash
npm install --global kiokuko-dsh
kiokuko setup
```

This keeps lexical retrieval and the normal setup flow available without the
optional local semantic runtime. To opt into local semantic retrieval, run the
following command. It installs the pinned optional dependencies when needed,
then applies the same client configuration flow as `kiokuko setup`: managed
MCP blocks are updated and registered-project instructions are refreshed.
Unmanaged MCP identities require interactive confirmation before replacement;
non-interactive or `--dry-run --json` runs fail closed without changing them.

```bash
kiokuko embeddings setup
```

`boolean@3.2.0` is an upstream transitive dependency of the Transformers.js
runtime. It is not a Kiokuko dependency and is not present in the lightweight
install. On Linux, the first automatic dependency installation uses sudo
through npm. On macOS it installs into Kiokuko's package-local `node_modules`
instead of the shared npm global prefix; other platforms invoke npm directly.
Do not persist npm script permissions or use `--dangerously-allow-all-scripts`.

`kiokuko embeddings setup` installs the pinned `local-small` preset without a
separate confirmation flag. Automation uses:

```bash
kiokuko embeddings setup --preset local-small --json
```

`--dry-run` performs no download, model load, database write, or filesystem
mutation. `--offline` uses only an existing verified installation. `--replace`
allows switching profiles. `status --json` reports bounded coverage and model
state; `repair` restores the same pinned artifact without destructive cleanup.
