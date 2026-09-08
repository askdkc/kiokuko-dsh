import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { formatDshOrcaStatus } from '../../../src/dsh/orca-status-presentation.js'
import { Config } from '../../../src/dsh/config.js'
import { DshOrcaRecorder } from '../../../src/dsh/orca-recorder.js'
import type { OrcaTrace } from '../../../src/dsh/orca-types.js'

const snapshot = () => ({ ...new DshOrcaRecorder(Config.parse({}).orca, async () => { throw new Error('no database access') }).status('session'),
  sessionRecording: 'awaiting_choice' })
const trace = (state: OrcaTrace['state']): OrcaTrace => ({ orca_run_id: 'run_abcdef', dsh_session_id: 'session',
  recorder_instance_id: 'private-owner', recording_generation: 'private-generation', workspace_key: 'private-key',
  store_root: '/project', session_cwd: '/project', capture_format_version: 1, state,
  started_at: '2026-09-08T00:00:00Z', ended_at: null, last_error_code: null, missing_event_count: 0,
  unresolved_call_count: 0, event_count: 0, recorded_bytes: 0, export_input_bytes: 0 })

test('compact status distinguishes consent, waiting, active and completed recording without exposing internal diagnostics', () => {
  const base = snapshot()
  for (const [choice, title] of [['awaiting_choice', '未開始（記録するか未選択）'], ['disabled', '記録停止中'], ['enabled', '記録待機中']]) {
    const text = formatDshOrcaStatus({ ...base, sessionRecording: choice! }, '/project')
    assert.equal(text.split('\n')[0], `OrcaReplay: ${title}`)
    assert.ok(text.includes(`保存先（記録開始後）: ${join('/project', '.orca', 'runs')}`))
    assert.ok(text.split('\n').length <= 5)
  }
  for (const [state, title] of Object.entries({ starting: '記録を開始しています', recording: '記録中', finalizing: 'ログを保存しています' })) {
    const text = formatDshOrcaStatus({ ...base, trace: trace(state as OrcaTrace['state']), sessionRecording: 'enabled' }, '/project')
    assert.equal(text.split('\n')[0], `OrcaReplay: ${title}`)
    assert.doesNotMatch(text, /記録済み:|private-|diagnostics|httpCapture|persistenceFailed/u)
  }
  const completed = { ...trace('completed'), ended_at: '2026-09-08T00:01:00Z', event_count: 12 }
  const text = formatDshOrcaStatus({ ...base, trace: completed, sessionRecording: 'disabled' }, '/project')
  assert.match(text, /^OrcaReplay: 記録完了\n/u)
  assert.match(text, /HTML 出力: \/kioku-orca export run_abcdef/u)
  assert.match(text, /記録済み: 12 イベント/u)
  assert.ok(text.includes(join('/project', '.orca', 'runs', 'run_abcdef')))
})

test('errors and incomplete recordings take priority over enabled preferences and retain recovery guidance', () => {
  const base = { ...snapshot(), sessionRecording: 'enabled' }
  for (const [overrides, title] of [
    [{ capability: 'disabled' }, '機能が無効です'],
    [{ capability: 'unavailable', unavailableReason: 'dependency_unavailable_reinstall_package' }, '記録機能を利用できません'],
    [{ persistenceFailed: true, trace: trace('recording') }, '保存に失敗しました'],
    [{ selectionError: 'recording_choice_persistence_failed' }, '保存に失敗しました'],
    [{ trace: { ...trace('incomplete'), missing_event_count: 2, unresolved_call_count: 1 } }, '記録に欠落があります'],
    [{ trace: { ...trace('failed'), ended_at: '2026-09-08T00:01:00Z' } }, '記録に失敗しました'],
  ] as const) {
    const text = formatDshOrcaStatus({ ...base, ...overrides }, '/project')
    assert.equal(text.split('\n')[0], `OrcaReplay: ${title}`)
    assert.match(text, /\/kioku-orca status --json/u)
    assert.doesNotMatch(text, /記録済み: 0/u)
    if ('trace' in overrides && overrides.trace.state === 'incomplete') assert.match(text, /欠落: 2 件 \/ 未完了の呼び出し: 1 件/u)
  }
  const noQuestion = formatDshOrcaStatus({ ...snapshot(), selectionError: 'recording_question_unavailable' }, '/project')
  assert.match(noQuestion, /\/kioku-orca start/u)
  assert.match(noQuestion, /確認を表示できませんでした/u)
})
