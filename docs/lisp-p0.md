# Common Lisp P0 実証記録

2026-09-16。本書は厳密な資源隔離を必須としていた **旧 P0 の実証記録**。その後、利用者の指示で安全対策を無断削除の防止中心に修正した。以下の反例や `readyForP1: false` は旧検査の観測・判定として残し、現在の計画で追加の資源 quota を必須に戻す根拠にはしない。Lisp worker と六つのツールを公開した証拠ではない。

本書は開発チェックアウト用。配布パッケージの利用手順や、対応 OS の宣言ではない。

## 実装した検査

- `scripts/probe-lisp-p0.ts`：通常表示と `--json`。一時領域に有限の C fixture をコンパイルする。Lisp・プロジェクトコードは実行しない。
- `scripts/lisp-p0/probe.ts`：候補 Seatbelt プロファイル、ローカル TCP/UDP/Unix socket の対照実験、明示した環境変数だけでの起動、結果収集、後始末。
- `scripts/lisp-p0/native-probe.c`：親と一つの子で、入力の読み取り・書き込み用 open、非公開ダミーファイルの読み取り、scratch 作成、接続、FD 3〜255 を確認する。実ファイル削除・fork bomb・メモリ枯渇試験は実行しない。
- `scripts/lisp-p0/resource-probe.c`：追加の仮想アドレス予約、1回の fork、最大40本の待機スレッドによる有限の検査。物理メモリの枯渇や無制限のプロセス生成を行わない。
- `tests/dsh/unit/lisp/p0-report.test.ts`：対照実験失敗、ECONNREFUSED/ENOENT、子だけの拒否失敗、不正な観測値を保護成功としない。
- `tests/dsh/integration/lisp/p0-native-guard.test.ts`：固定した実 DSH registry のガードを試す。カウンター以外の副作用を持たない fixture を使う。
- `tests/dsh/integration/lisp/p0-seatbelt.test.ts`：macOS の実プロセスで起動・拒否・資源制限の反例を再検証する。専用の環境変数で明示実行した場合、未実行や環境不足を成功扱いにしない。

検査プログラムの隔離と、信頼しない任意コードを受け付ける製品の隔離は別である。プローブが部分的に通っても `readyForP1` は false のまま。現在のプローブは admission に接続せず、手動で結果を書き換えても製品の実行権限にはならない。

## 再現方法

Node.js、開発依存関係、C compiler、SBCL を準備した開発チェックアウトで実行する。インストール・VM 作成・ユーザー設定変更は検査に含めない。

```sh
npm run probe:lisp:p0
node --import tsx scripts/probe-lisp-p0.ts --json
node scripts/run-tests.mjs tests/dsh/unit/lisp
KIOKUKO_DSH_PACKAGE_ROOT="$PWD/tests/fixtures/dsh-runtime/node_modules" \
  KIOKUKO_REQUIRE_DSH_NATIVE=1 \
  node scripts/run-tests.mjs tests/dsh/integration/lisp
npm run typecheck
# macOS のネイティブ検査。loopback 待受けと sandbox-exec が必要。
KIOKUKO_REQUIRE_LISP_P0=1 \
  node scripts/run-tests.mjs tests/dsh/integration/lisp/p0-seatbelt.test.ts
```

probe の終了コードは 2 が P0 未通過、1 が検査自体の回収不能なエラー、64 が引数不備。隔離ランチャーが起動不能でも通常実行へフォールバックしない。対照実験は固定した fixture に対して最初に行い、製品コードの再実行ではない。

外側の実行制限で loopback 待受けが拒否される場合、ネットワーク隔離を実証したとは数えない。この調査では通常のツール実行環境で `listen EPERM` が発生したため、承認された限定実行で同じダミー検査を行った。

## 得られた証拠と未確認範囲

実行結果は [JSON 記録](lisp-p0-darwin-arm64.json) に保存した。

| 項目 | 結果 |
|---|---|
| 環境 | Darwin 27.0.0 / arm64、Node v26.5.0、SBCL 2.6.4 |
| 通常の C fixture | 起動と親・子の観測出力を確認 |
| RLIMIT_FSIZE | 4 KiB の制限でも、2ファイルへ合計6 KiBを書ける反例を確認。scratch 全体の quota の代用にはならない |
| Seatbelt 候補 | 起動時の SIGABRT は `/` ディレクトリ自体への `file-read-data` 許可不足だった。`literal "/"` のみ追加し、親・子の入力書き込み／非公開ファイル読み取り／TCP・UDP・Unix socket 接続が拒否されることを確認。ルート配下の一括許可は追加していない |
| fork 禁止候補 | 同じ有限 fixture の fork が通常実行で成功し、fork 許可を外した Seatbelt で EPERM になることを確認 |
| RLIMIT_NPROC | fork 禁止の Seatbelt 内で上限を1に設定しても40本の待機スレッドを作成できた。計画の32 task 上限には使えない |
| RLIMIT_AS | 現在の仮想アドレス量に16 MiBを加えた上限で、追加32 MiBの予約が ENOMEM になることを確認。既存マッピング込みの上限であり、物理メモリ1 GiBや子孫合計の保証ではない |
| メモリ・CPU・task 数 | 子孫合計に対する hard limit は未実装・未実証 |
| scratch | 固定容量 filesystem の mount・全体予約は未実装 |
| 停止・host crash | 所有範囲を OS が保持する構成と、その回復は未実証 |
| DSH registry | 0.1.5-rc.1 で、allow リスナーより最終 guard が優先され、直接・ネスト入力・子 scope・動的登録への呼び出しを拒否。body カウンターは進まない |
| DSH guard 解除 | guard を解除すると同じ実行が通ることも確認。プラグイン解除時まで残る host admission fence が別途必要 |
| Linux / macOS x64 | この環境では未検証。skip や静的文書は対応証拠に数えない |

DSH 試験の子は registry の scope primitive で結び付けた fixture で、実際の子 agent を起動していない。ネスト試験も registry の nested 入力経路であり、PTC runtime の起動、agent loop、Web、plugin hot reload を通した実証ではない。

修正後の関連検査は15件成功、失敗・skip は0件。内訳は新規 unit 5件、実 DSH registry 1件、macOS native 1件、既存 tool-policy 8件。型検査も通過。これは P0 の各サンプルと回帰検査の結果であり、P1〜P6 の完了証拠ではない。

## DSH 接続図と後続工程に必要な変更

```text
native model tool ─┐
child agent ───────┼─ ToolRuntime.execute / scheduler ─ pre-execute ─ guard ─ body
PTC dispatch ──────┘                                     ↑
                                         保護 admission と登録実体の検証

agent/pre-step ─ 保護準備・回復状態を判定 ─ model request
plugin unload ─ 新規受付停止 ─ 所有処理を停止・照合 ─ guard 解除
```

- `src/dsh/tool-policy.ts` は対象外の一般ツールを通す。既存 policy を保ったまま、保護セッションの追加ガードが必要。
- `src/dsh/composition.ts` の pre-step は一部の mapping 失敗で `next()` へ進む既存契約を持つ。任意機能の案内が失敗しても進む契約と、保護 admission の必須拒否を混ぜてはならない。
- `ToolRuntime.guard()` の解除後に実行が再開できるため、hot reload/unload 中の session fence は guard disposer より長くホスト側で所有する必要がある。
- 現在の fixture で確認した公開 API は最終 guard、登録変更通知、scope 親子関係。製品の全 lifecycle をプラグインの公開 API だけで強制できるかは未確定。必要な DSH 本体変更・対応版を確定したとは扱わない。

## 旧 P0 の停止理由と要件変更

旧 `PLAN.md` §12 は全資源制限の実証失敗時に後続実装を止める契約だった。起動不良は修正し、macOS の fork 禁止と RLIMIT_NPROC の組合せで32 task 上限を満たせない反例を得た。現在はこの厳密な quota を初版の必須条件から外したため、当該反例を実装停止の理由にしない。削除前のホスト認可と、その迂回を防ぐ検証は引き続き必要である。

旧要件で未達だった事項（現在の通過条件は `PLAN.md` §12 を参照）：

1. macOS の子孫全体の資源制限・終了を実証できる backend を確定する。Seatbelt・setrlimit・PID group だけで達成したとは扱わない。専用 Linux VM 案は、プラグインに追加実行環境を要求する構成として利用者が不適切と判断したため撤回した。VM・container は導入していない。
2. Linux の Bubblewrap、委譲 cgroup v2、固定容量 scratch を使う試作を制限済み環境で検証する。
3. 実 DSH agent/子 agent/PTC/登録差し替え/解除を通した admission 試験を追加し、必要な host 変更と対応版を固定する。
4. VM 案の撤回に続き、利用者から無断削除の防止を中心にする明示的な要件変更があった。両 OS で削除ガードの実効性を検証し、追加の資源 quota の検証とは分けて進める。

macOS で絶対に実装不可能という結論ではない。現在の候補と環境では要求された強制力を証明できていない、という結果である。

## 参照

- [Apple setrlimit](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/setrlimit.2.html)：プロセス資源とファイルサイズの制限。
- [Apple XNU の現在の資源制限実装](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_resource.c)：RLIMIT_AS の上限検証も照合。古いマニュアルだけから無効と判断しない。
- [Linux cgroup v2](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)：子孫の資源制御。filesystem quota とは別。
- [DSH subprocess-local](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subprocess/subprocess-local/README.md)：macOS fallback の所有・停止範囲の限界。
- [Chromium の macOS sandbox profile](https://github.com/chromium/chromium/blob/main/sandbox/policy/mac/common.sb)：システムライブラリの実行マッピング等の確認に使用。全 profile は導入していない。
