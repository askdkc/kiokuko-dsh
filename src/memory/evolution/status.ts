/** Status contains counts and fixed classifications only, never evidence text. */
export function formatEvolutionStatus(status: Record<string, unknown>): string {
  const rows = status.jobs as Array<{ state: string; count: number; reason: string | null }>
  const count = (state: string) => rows.filter(row => row.state === state).reduce((n,row) => n + row.count, 0)
  const calls = status.calls as { count: number; inputTokens: number | null; outputTokens: number | null; durationMs: number | null }
  const extraction = [...status.extraction as Array<{reason:string;count:number}>, ...status.skips as Array<{reason:string;count:number}>]
  const reasons: Record<string,string> = {
    insufficient_independent_support: '独立した根拠または観測された成功が不足', conflicting_procedures: '手順が相互に矛盾', waiting_for_three_new_episodes: '新たな独立 episode 3件を待機', bounded_support_insufficient: '入力上限内の根拠が不足',
    missing_log_boundary: 'ログの開始・終了範囲が未確定', disabled: '設定で停止中',
    invalid_or_missing_episode: 'episode の証拠または形式が不正', episode_persistence_rejected: 'episode の保存条件を満たさない',
    model_unavailable: '指定モデルを利用できない', model_failed: '生成に失敗', invalid_json: '生成結果の形式が不正',
    context_budget_or_support: '入力容量または独立した根拠が不足', call_budget: '追加呼び出しの上限',
    timeout_or_closed: '時間切れまたはホスト終了', source_changed: '根拠が変更された',
    expired_dispatched_claim: '呼び出し後の処理結果が未確定', attempt_limit: '再開回数の上限',
    evolution_stale_claim: '処理期限または設定が変更された', evolution_stale_or_conflicting: '根拠が失効または矛盾',
    evolution_conflicting_procedures: '手順が相互に矛盾', evolution_unsupported_synthesis: '未観測の手順を含む',
  }
  const skips = [...extraction, ...rows.filter(row=>row.reason).map(row=>({reason:row.reason!,count:row.count}))]
  return [
    `記憶の学習: ${String(status.mode)}（要求: ${String(status.requested)}）`,
    `候補の検索・自動注入: ${status.mode === 'active' ? '有効（根拠が有効な未検証候補）' : '無効'}`,
    '品質評価: 実モデルでの改善率は未測定',
    `episode: ${String((status.episodes as {count:number}).count)} 件 / 根拠失効等で保留した派生記憶: ${(status.derivations as {held:number}).held} 件`,
    `待機 ${count('pending')} / 処理中 ${count('processing')} / 完了 ${count('completed')} / 保留 ${count('held')} / 失敗 ${count('failed')}`,
    `追加呼び出し: ${calls.count} 回 / 入力 token: ${calls.inputTokens ?? '未報告'} / 出力 token: ${calls.outputTokens ?? '未報告'}`,
    `生成時間（累計）: ${calls.durationMs === null ? '未報告' : `${calls.durationMs} ms`}`,
    ...skips.map(row => `見送り: ${reasons[row.reason] ?? '採用条件を満たさない'} ${row.count} 件`),
  ].join('\n')
}
