import assert from 'node:assert/strict'
import test from 'node:test'
import { ENNO_NEXT_ACTIONS } from '../../../src/enno-oduno/types.js'
import { DSH_ENNO_NEXT_ACTION_HANDLERS } from '../../../src/dsh/enno-controller.js'

test('the dsh handler map covers every Enno next action exactly once', () => {
  assert.deepEqual(Object.keys(DSH_ENNO_NEXT_ACTION_HANDLERS), [...ENNO_NEXT_ACTIONS])
  assert.equal(new Set(Object.keys(DSH_ENNO_NEXT_ACTION_HANDLERS)).size, ENNO_NEXT_ACTIONS.length)
  assert.deepEqual(
    ENNO_NEXT_ACTIONS.filter((action) => DSH_ENNO_NEXT_ACTION_HANDLERS[action].kind === 'terminal'),
    ['report_blocker', 'complete'],
  )
})
