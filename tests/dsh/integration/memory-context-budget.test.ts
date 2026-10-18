import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, failure, capabilities } from './enno-memory/fixture.js'
import { recordEntry } from '../../../src/memory/entries.js'
import { readContextDelivery } from '../../../src/context/delivery.js'
import { refreshContinuedTaskContext } from '../../../src/dsh/task-intake.js'
import { injectDshContext } from '../../../src/dsh/context-injection.js'

for (const configuredBudget of [undefined, 4000, 32000]) {
  test(`continued and Enno requests retain their bound body budget: ${configuredBudget ?? 'default'}`, async () => {
    const f = await fixture('active', 1, 8, configuredBudget)
    const budget = configuredBudget ?? 16000
    try {
      const body = 'E_LOCK_TIMEOUT ' + '😀'.repeat(12000)
      recordEntry(f.db, { workspace: f.prepared.project.workspace, kind: 'lesson', title: 'E_LOCK_TIMEOUT Unicode guidance', body, createdBy: 'fixture', scope: { visibility: 'project' } })
      await f.service.refresh(f.binding())
      f.service.observeResult(f.prepared.run.runId, f.agent, f.session, f.root, failure)
      await f.service.refresh(f.binding())
      assert.ok(f.prepared.context?.deliveryId)
      const selected = readContextDelivery(f.db, { workspace: f.prepared.project.workspace, deliveryId: f.prepared.context!.deliveryId! })
      assert.equal(selected.charBudget, budget)
      const messages = await injectDshContext({ prepared: f.prepared, task: 'E_LOCK_TIMEOUT', runtime: f.runtime })
      assert.equal(messages.some(message => message.source === 'memory' && message.content.includes('😀'.repeat(12000))), budget >= 16000)
      const continued = await refreshContinuedTaskContext({ database: f.db, prepared: f.prepared,
        task: 'E_LOCK_TIMEOUT', capabilities, assertCurrent: () => {}, validateCapabilities: async () => {} })
      assert.ok(continued.context?.deliveryId)
      assert.equal(readContextDelivery(f.db, { workspace: f.prepared.project.workspace, deliveryId: continued.context!.deliveryId! }).charBudget, budget)
    } finally { await f.close() }
  })
}
