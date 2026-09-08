import { join } from 'node:path'
import type { DshOrcaHostServices } from './orca-types.js'

type Status = ReturnType<DshOrcaHostServices['recorder']['status']>
  & Awaited<ReturnType<DshOrcaHostServices['sessionRecordingStatus']>>

/** Present the current session first; retain internal diagnostics in status --json. */
export function formatDshOrcaStatus(status: Status, storeRoot: string): string {
  const trace = status.trace
  const states = { starting: '記録を開始しています', recording: '記録中', finalizing: 'ログを保存しています',
    completed: '記録完了', incomplete: '記録に欠落があります', failed: '記録に失敗しました' }
  let title: string
  let next: string
  if (status.capability === 'disabled') {
    title = '機能が無効です'
    next = '設定で orca.enabled を true にして DSH を再読み込みしてください。'
  } else if (status.capability === 'unavailable') {
    title = '記録機能を利用できません'
    next = 'Kiokuko の導入状態を確認し、DSH を再起動してください。'
  } else if (status.persistenceFailed || status.selectionError === 'recording_choice_persistence_failed') {
    title = '保存に失敗しました'
    next = 'Kiokuko のデータ保存先の権限・空き容量を確認してください。'
  } else if (trace) {
    title = states[trace.state]
    next = trace.state === 'starting' || trace.state === 'recording'
      ? '停止して保存: /kioku-orca stop'
      : trace.state === 'finalizing' ? '保存完了後に /kioku-orca status で確認できます。'
        : trace.state === 'completed' ? `HTML 出力: /kioku-orca export ${trace.orca_run_id}`
          : '詳細: /kioku-orca status --json'
  } else if (status.sessionRecording === 'enabled') {
    title = '記録待機中'
    next = '次のモデル応答・ツール実行から記録します。停止: /kioku-orca stop'
  } else {
    title = status.sessionRecording === 'disabled' ? '記録停止中' : '未開始（記録するか未選択）'
    next = '記録を開始: /kioku-orca start'
  }
  const lines = [`OrcaReplay: ${title}`, next]
  if (trace) {
    lines.push(`保存先: ${join(trace.store_root, '.orca', 'runs', trace.orca_run_id)}`)
    // The recorder finalizes event_count on close; zero during capture is not a measured count.
    if (trace.ended_at !== null && trace.state !== 'failed') lines.push(`記録済み: ${trace.event_count} イベント`)
    if (trace.missing_event_count || trace.unresolved_call_count) {
      lines.push(`欠落: ${trace.missing_event_count} 件 / 未完了の呼び出し: ${trace.unresolved_call_count} 件`)
    }
  } else if (status.capability === 'available') {
    lines.push(`保存先（記録開始後）: ${join(storeRoot, '.orca', 'runs')}`)
  }
  if (status.selectionError === 'recording_question_unavailable') lines.push('注意: 記録するかの確認を表示できませんでした。')
  if (next !== '詳細: /kioku-orca status --json') lines.push('詳細: /kioku-orca status --json')
  return lines.join('\n')
}
