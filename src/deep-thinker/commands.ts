export type DeepCommand = { kind: 'start'; task: string } | { kind: 'arm' | 'status' | 'cancel' | 'resume' | 'configure' | 'help' }
export function parseDeepCommand(raw: string): DeepCommand {
  raw = raw.replace(/^(?:[ \t]|\r?\n)/u, '')
  if (!raw.trim()) return { kind: 'arm' }
  // Only the delimiter is removed. Embedded newlines, indentation and code remain literal.
  if (raw === '--') return { kind: 'arm' }
  if (/^--\s/u.test(raw)) return { kind: 'start', task: raw.replace(/^--(?:\r?\n|[ \t])/u, '') }
  const flag = raw.trim()
  for (const kind of ['status','cancel','resume','configure','help'] as const) if (flag === `--${kind}`) return { kind }
  if (/^--/u.test(raw)) throw new Error('不明なオプションです。本文を -- で区切るか、--help を参照してください。')
  return { kind: 'start', task: raw }
}
export const DEEP_HELP = `/deep-planning <本文> — テキストとworkspace内資料を使う調査・分析・設計・計画\n/deep-planning — 次の人間による通常入力を一度だけ予約\n--status 状態・未配送回答を確認\n--cancel 取消し\n--resume 同じSessionの保存済み作業を再開・復旧\n--configure 四役のモデルと予算を設定\n--help この説明\n-- <本文> オプションとして解釈せず開始\n添付、ファイル変更、shell、実装への自動移行には対応していません。トークン予算は推定を含みます。`
