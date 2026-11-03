import assert from 'node:assert/strict'
import test from 'node:test'
import { installDshModelRouting, type ModelRoutingChoice, type RoutableAgent } from '../../../src/dsh/model-routing.js'

/** A minimal client-side agent: enough surface for the routing guards, with a
 * runMaintenance that actually executes the maintenance task like the real
 * harness does. */
function routingAgent(overrides: Partial<RoutableAgent> = {}): RoutableAgent {
  return Object.assign({
    id: 'fixture-agent',
    status: 'idle',
    inbox: { nextStep: [], nextTurn: [] },
    model: { current: () => undefined, select: () => undefined },
    runMaintenance: (task: (signal: AbortSignal) => Promise<void>) => task(new AbortController().signal),
  }, overrides) as RoutableAgent
}

test('a stale routing maintenance failure surfaces once and the next assembly recovers the route', async () => {
  const listeners = new Map<string, Array<unknown>>()
  const agent = routingAgent({
    ctx: {
      on(name: string, listener: unknown): () => void {
        const list = listeners.get(name) ?? []
        list.push(listener)
        listeners.set(name, list)
        return () => { const i = list.indexOf(listener); if (i >= 0) list.splice(i, 1) }
      },
    },
  })
  let outages = 1
  let consultations = 0
  const beforeAssembly = async (): Promise<ModelRoutingChoice> => {
    consultations++
    if (outages > 0) { outages--; throw new Error('Fixture routing outage') }
    return undefined
  }
  const outbox = installDshModelRouting(agent, beforeAssembly)
  try {
    const inserted = listeners.get('agent/inbox/inserted')
    const assemble = listeners.get('system-prompt/assemble')
    const request = listeners.get('agent/request')
    assert.ok(inserted && assemble && request, 'routing registers its listeners')
    // A message insertion runs the maintenance routing pass and it fails.
    ;(inserted[0] as (event: unknown) => void)({ agent })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(consultations, 1)
    // The next assembly surfaces the stale failure instead of consulting again.
    await assert.rejects(
      (assemble[0] as (event: unknown, context: unknown, next: () => Promise<unknown>) => Promise<unknown>)(
        undefined, {}, async () => { assert.fail('assembly must not continue behind a stale failure') }),
      /Fixture routing outage/,
    )
    assert.equal(consultations, 1)
    // The failure clears after surfacing: the next assembly consults routing
    // again and proceeds instead of failing forever until an inbox insert.
    const outcome = await (assemble[0] as (event: unknown, context: unknown, next: () => Promise<unknown>) => Promise<unknown>)(
      undefined, {}, async () => ({ sections: [], variables: {} }))
    assert.equal(consultations, 2)
    assert.deepEqual(outcome, { sections: [], variables: {} })
  } finally { outbox() }
})
