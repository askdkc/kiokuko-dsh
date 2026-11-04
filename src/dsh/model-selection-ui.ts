import type { StoredExecutionSelection, ExecutionSelection } from './execution-selection.js'

import { ExecutionSelectionPending } from './execution-pending.js'
export { ExecutionSelectionPending } from './execution-pending.js'

interface SelectionUiInput {
  readonly signal: AbortSignal
  readonly stored: StoredExecutionSelection
  readonly save: (revision: number, value: ExecutionSelection) => Promise<StoredExecutionSelection>
}

/**
 * The execution-mode card was removed: every run proceeds with the current DSH
 * model. A ready selection returns unchanged; a pending or legacy selection
 * becomes durably ready without a question. Head/worker pairs keep coming from
 * the saved session default in Settings → Kiokuko Models.
 */
export async function selectExecution(input: SelectionUiInput): Promise<StoredExecutionSelection> {
  const stored = input.stored
  if (stored.value.status === 'ready') return stored
  if (input.signal.aborted) throw new ExecutionSelectionPending()
  const { mode: _mode, status: _status, configuration: _configuration,
    deepConfiguration: _deepConfiguration, draft: _draft, problem: _problem,
    discussion: _discussion, ...carried } = stored.value
  return await input.save(stored.revision, { mode: 'normal', status: 'ready', ...carried })
}
