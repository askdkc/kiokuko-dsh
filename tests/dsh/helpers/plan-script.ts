import assert from 'node:assert/strict'
import { interpretedPreparation } from './coding-script.js'

/** Scripted interpretation for this fixed Plan fixture, not a language classifier.
 * Each native turn must bind its fresh host evidence, including the active task.
 */
export function planPreparation(mock: any, id: string, mode: string) {
  assert.ok(['question', 'keep', 'approve'].includes(mode), 'unknown Plan fixture mode')
  return interpretedPreparation(mock, id, mode === 'question' ? 'new' : 'same_scope_continuation', 'research', 'research')
}
