import assertNode from 'node:assert/strict'
import test from 'node:test'
import { DshContinuationRegistry } from '../../../../src/dsh/agent-state.js'

test('resume tokens are exact route credentials and cannot be reused after reroute', () => {
  const registry = new DshContinuationRegistry()
  const binding = { resumeToken: 'opaque-token', dshSessionId: 'session-a', runId: 'run-a', workspace: 'workspace-a', routeEpoch: 3 } as const
  registry.bind(binding)
  assertNode.deepEqual(registry.resolve(binding), binding)
  for (const changed of [
    { dshSessionId: 'session-b' }, { runId: 'run-b' }, { workspace: 'workspace-b' }, { routeEpoch: 4 },
  ]) assertNode.throws(() => registry.resolve({ ...binding, ...changed }), /exact dsh route/u)
  assertNode.equal(registry.size, 1)
})
