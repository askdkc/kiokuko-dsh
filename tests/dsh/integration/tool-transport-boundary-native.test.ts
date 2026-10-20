/** Raw registration coverage through the pinned native scheduler and actual PTC interpreter. */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createDshToolDefinitions } from '../../../src/dsh/tools.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT
const available = packages !== undefined && existsSync(join(packages, '@deepseek-ai/dsh/package.json'))
if (!available && (packages !== undefined || process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1')) throw new Error('Native transport coverage requires an installed pinned DSH package root')
for (const mode of ['native', 'ptc'] as const) test(`raw register validates transport before effects in actual ${mode} runtime`, { skip: !available, timeout: 60_000 }, async () => {
  const version = JSON.parse(await readFile(join(packages!, '@deepseek-ai/dsh/package.json'), 'utf8')).version
  const expected = JSON.parse(await readFile('tests/fixtures/dsh-runtime/package.json', 'utf8')).dependencies['@deepseek-ai/dsh']
  assert.equal(version, expected)
  const load = (name: string) => import(pathToFileURL(join(packages!, '@deepseek-ai', name, 'lib/index.js')).href)
  const cordis = await load('cordis'), ctx = new cordis.Context(), fibers: any[] = []
  const root = await mkdtemp(join(tmpdir(), 'tool-transport-native-'))
  let binds = 0, effects = 0
  try {
    for (const [name, config] of [
      ['dsh-llm', undefined], ['dsh-session', undefined], ['dsh-session-projection', undefined], ['dsh-system-prompt', { persona: '' }],
      ['dsh-fs-local', { cwd: root }], ['dsh-working-directory', { defaultDirectory: root }],
      ['dsh-subprocess-local', undefined], ['dsh-sandbox-local', undefined],
      ['dsh-sandbox-policy', { mode: 'read-only', workspaceRoot: root }],
      ['dsh-ptc-runtime-node', { timeoutMs: 10_000 }], ['dsh-tools', { mode }],
    ] as const) { const fiber = ctx.plugin((await load(name)).default, config); fibers.push(fiber); await fiber }
    const definitions = createDshToolDefinitions({
      bind() { binds++; return { runId: 'run', workspace: 'workspace', orchestrationId: 'orch', revision: 1, routeEpoch: 0, workUnitId: 'work', leaseToken: 'lease' } },
      async execute() { effects++; return { kind: 'retry', reason: 'business validation' } },
    })
    for (const definition of definitions) ctx.tools.register(definition)
    let call = 0
    async function invoke(args: unknown) {
      return ctx.tools.execute({ callId: `call-${++call}`, name: mode === 'native' ? 'enno_work_report' : 'run_code',
        arguments: mode === 'native' ? args : { description: 'Check raw transport boundary', code: `return await tools.enno_work_report(${JSON.stringify(args)})` }, signal: new AbortController().signal })
    }
    for (const args of [{ result: '{}' }, { result: { changedPaths: [1] } }, { result: { mutated: 'false' } }, { result: '{}', workspace: 'forged' }]) {
      const result = await invoke(args)
      assert.equal(result.isError, true, JSON.stringify(result))
      assert.match(JSON.stringify(result), 'workspace' in args ? /host-owned identity/ : /published transport schema/)
      assert.equal(binds, 0); assert.equal(effects, 0)
    }
    const result = await invoke({})
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal(binds, 1); assert.equal(effects, 1)
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
