# Continuity

## 機能

最近の実行記録を短くまとめ、`kiokuko:execution` に表示します。

- `off`: 無効（既定値）
- `shadow`: 要約を作るが、モデルへの入力は変えない
- `active`: 最近の証拠表示を要約に置き換える

## メリット

何を読んだか、次に何を確認すべきかをモデルが把握しやすくなります。
要約のサイズと件数には上限があるため、コンテキストの増加も抑えられます。

## 設定方法

`~/.dsh/profiles/web/cordis.patch.yml` に次を追加します。

```yaml
- id: kiokuko-dsh
  config:
    continuity:
      mode: active
      maxSupplementBytes: 4096
      maxItems: 12
```

同じ行にほかの `config` がある場合は、その設定を残したまま `continuity` を追加してください。
`web` プロファイルでは自動で反映されます。設定内容は
`dsh --profile web --dump-config` で確認できます。
