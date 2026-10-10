import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { mountNativeSearch } from '../../../src/dsh/native-search.js'

const packageRoot = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const nativeManifest = join(packageRoot, '@deepseek-ai/dsh/package.json')
const nativeAvailable = existsSync(nativeManifest)
const native = { skip: nativeAvailable ? false : 'requires the packaged DSH runtime' as const, timeout: 45000 }
if (!nativeAvailable && (process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1' || process.env.KIOKUKO_DSH_PACKAGE_ROOT !== undefined)) {
  throw new Error('Native search coverage requires KIOKUKO_DSH_PACKAGE_ROOT')
}
if (nativeAvailable) {
  const manifest = JSON.parse(await readFile(nativeManifest, 'utf8')) as { version?: string }
  const expectedVersion = process.env.KIOKUKO_EXPECTED_DSH_VERSION
    ?? JSON.parse(await readFile(join(process.cwd(), 'tests/fixtures/dsh-runtime/package.json'), 'utf8')).dependencies['@deepseek-ai/dsh']
  assert.equal(manifest.version, expectedVersion)
}

function modulePath(name: string): string {
  return pathToFileURL(join(packageRoot, '@deepseek-ai', name, 'lib/index.js')).href
}

async function createHarness(options: { readonly grepMaxMatches?: number } = {}) {
  if (!nativeAvailable) throw new Error('native runtime is unavailable')
  const [cordis, scope, session, projection, systemPrompt, fsLocal, workingDirectory, tools, subprocess, search] = await Promise.all([
    import(modulePath('cordis')),
    import(modulePath('dsh-scope')),
    import(modulePath('dsh-session')),
    import(modulePath('dsh-session-projection')),
    import(modulePath('dsh-system-prompt')),
    import(modulePath('dsh-fs-local')),
    import(modulePath('dsh-working-directory')),
    import(modulePath('dsh-tools')),
    import(modulePath('dsh-subprocess-local')),
    import(modulePath('dsh-tool-fs-search')),
  ])
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-native-search-'))
  let savedSpill: any
  const ctx = new cordis.Context()
  const fibers: any[] = []
  const config = {
    sampleOverCapGlobResults: false,
    globMaxResults: 100,
    grepMaxMatches: options.grepMaxMatches ?? 250,
    grepMaxLineBytes: 10000,
    searchMetaMaxBytes: 65536,
    rawOutputMaxBytes: 20_000_000,
    graceMs: 3000,
    stderrMaxBytes: 65536,
    timeoutMs: 30000,
  }
  const spill = { saveText: async (input: unknown) => {
    savedSpill = input
    return { locator: 'spill://native-search-test', retrievalHint: 'retrieve the complete result' }
  } }
  ctx.provide('spillStore', spill)
  for (const [plugin, configValue] of [
    [systemPrompt.default, { persona: '' }],
    [projection.default, undefined],
    [fsLocal.default, { cwd: root }],
    [workingDirectory.default, { defaultDirectory: root }],
    [tools.ToolRuntime, { mode: 'native' }],
    [subprocess.default, undefined],
    [{ name: search.name, inject: search.inject, Config: search.Config, apply: search.apply }, config],
  ] as const) {
    const fiber = ctx.plugin(plugin as any, configValue)
    fibers.push(fiber)
    await fiber
  }
  const toolsService: any = ctx.get('tools', false)
  const nativeDefinition = toolsService.get('grep')
  const releaseSearchHook = mountNativeSearch(ctx as any)
  const sessionId = session.SessionId('native-search-session')
  const nativeSession = session.Session.create(sessionId, [], {
    version: 4, id: sessionId, createdAt: Date.now(), cwd: root, isSeeded: false,
  } as any)
  const agent: any = { id: 'native-search-agent', session: nativeSession }
  const agentScope = scope.createScope(ctx, agent)
  agent.ctx = agentScope.ctx
  await ctx.emit('agent/session-start', { agent })
  let callId = 0
  const execute = (arguments_: unknown, signal = new AbortController().signal) => toolsService.execute({
    name: 'grep', callId: `native-search-${++callId}`, arguments: arguments_, agent, signal,
  })
  return {
    root,
    ctx,
    nativeDefinition,
    tools: toolsService,
    agent,
    execute,
    get savedSpill() { return savedSpill },
    async close() {
      releaseSearchHook()
      await agentScope.dispose()
      for (const fiber of fibers.reverse()) await fiber.dispose?.()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('native grep keeps its definition and ripgrep glob semantics', native, async () => {
  const h = await createHarness()
  try {
    await mkdir(join(h.root, 'src', 'nested'), { recursive: true })
    await writeFile(join(h.root, 'root.ts'), 'needle\n')
    await writeFile(join(h.root, 'src', 'index.ts'), 'needle\n')
    await writeFile(join(h.root, 'src', 'nested', 'deep.ts'), 'needle\n')
    const definition = h.tools.get('grep', h.agent) as any
    assert.ok(definition)
    assert.equal(definition, h.nativeDefinition, 'agent scope must retain the exact native definition')
    const execute = definition.execute
    assert.equal(definition.name, 'grep')
    assert.equal(definition.timeoutMs, 30000)
    assert.deepEqual(definition.parameters.required, ['pattern'])
    assert.equal(definition.output.schema.properties.matches.items.properties.lineNumber.type, 'integer')

    const nested = await h.execute({ pattern: 'needle', include: 'src/**/*.ts' }) as any
    assert.equal(nested.isError, false, JSON.stringify(nested))
    assert.deepEqual(nested.value.matches.map((match: any) => match.path).sort(), ['src/index.ts', 'src/nested/deep.ts'])
    const rootAndNested = await h.execute({ pattern: 'needle', include: '**/*.ts' }) as any
    assert.deepEqual(rootAndNested.value.matches.map((match: any) => match.path).sort(), ['root.ts', 'src/index.ts', 'src/nested/deep.ts'])
    assert.equal((h.tools.get('grep', h.agent) as any).execute, execute, 'the hook must not replace native grep')
  } finally { await h.close() }
})

test('native grep preserves structured failures while improving missing-path text', native, async () => {
  const h = await createHarness()
  try {
    const missing = await h.execute({ pattern: 'needle', path: 'does-not-exist.txt' }) as any
    assert.equal(missing.isError, true, JSON.stringify(missing))
    assert.equal(missing.error?.info?.code, 'SEARCH_FAILED')
    assert.match(missing.content.map((block: any) => block.text ?? '').join('\n'), /cannot search "does-not-exist\.txt": not found.*check the path/isu)

    const invalid = await h.execute({ pattern: '[' }) as any
    assert.equal(invalid.isError, true, JSON.stringify(invalid))
    assert.equal(invalid.error?.info?.code, 'SEARCH_INVALID_PATTERN')
    assert.match(invalid.content.map((block: any) => block.text ?? '').join('\n'), /invalid|regex|pattern/iu)

    await writeFile(join(h.root, 'fixture.txt'), 'ordinary fixture content\n')
    const none = await h.execute({ pattern: 'never-present-in-fixture' }) as any
    assert.equal(none.isError, false, JSON.stringify(none))
    assert.match(none.content.map((block: any) => block.text ?? '').join('\n'), /No matches found/iu)
  } finally { await h.close() }
})

test('native grep waits for downstream post-execute policy and preserves an eligible error replacement', native, async () => {
  const h = await createHarness()
  const release = h.ctx.on('tools/post-execute', async (_execution: unknown, _result: unknown, next: () => Promise<any>) => {
    const decision = await next()
    return { ...decision, content: [{ type: 'text', text: 'downstream replacement' }], additionalContexts: [{ type: 'text', text: 'downstream context' }] }
  })
  try {
    const result = await h.execute({ pattern: 'needle', path: 'does-not-exist.txt' }) as any
    assert.equal(result.isError, true, JSON.stringify(result))
    assert.equal(result.error?.info?.code, 'SEARCH_FAILED')
    assert.deepEqual(result.content, [{ type: 'text', text: 'downstream replacement' }])
    assert.deepEqual(result.additionalContexts, [{ type: 'text', text: 'downstream context' }])
  } finally { release(); await h.close() }
})

test('native grep adds missing-path guidance while retaining downstream contexts', native, async () => {
  const h = await createHarness()
  const release = h.ctx.on('tools/post-execute', async (_execution: unknown, _result: unknown, next: () => Promise<any>) => {
    const decision = await next()
    return { ...decision, additionalContexts: [{ type: 'text', text: 'downstream context' }] }
  })
  try {
    const result = await h.execute({ pattern: 'needle', path: 'does-not-exist.txt' }) as any
    assert.equal(result.isError, true, JSON.stringify(result))
    assert.equal(result.error?.info?.code, 'SEARCH_FAILED')
    assert.match(result.content.map((block: any) => block.text ?? '').join('\n'), /cannot search "does-not-exist\.txt": not found.*check the path/isu)
    assert.deepEqual(result.additionalContexts, [{ type: 'text', text: 'downstream context' }])
  } finally { release(); await h.close() }
})

test('native grep remains cancellable, handles large files, and spills capped results', native, async () => {
  const h = await createHarness({ grepMaxMatches: 2 })
  try {
    await writeFile(join(h.root, 'large.txt'), 'needle\n' + 'x'.repeat(2 * 1024 * 1024 + 128))
    const large = await h.execute({ pattern: 'needle', path: 'large.txt' }) as any
    assert.equal(large.isError, false, JSON.stringify(large))
    assert.equal(large.value.matches.length, 1)

    await writeFile(join(h.root, 'pathological.txt'), 'a'.repeat(30000) + 'b\n')
    let timer: ReturnType<typeof setTimeout> | undefined
    let pathological: any
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('native grep exceeded bounded test time')), 5000) })
      pathological = await Promise.race([h.execute({ pattern: '(a+)+$', path: 'pathological.txt' }), timeout]) as any
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    assert.equal(pathological.isError, false, JSON.stringify(pathological))

    await writeFile(join(h.root, 'many.txt'), Array.from({ length: 20 }, (_, index) => `needle-${index}`).join('\n') + '\n')
    const capped = await h.execute({ pattern: 'needle', path: 'many.txt' }) as any
    assert.equal(capped.isError, false, JSON.stringify(capped))
    assert.equal(capped.value.matches.length, 20, 'the native value retains complete matches for spill and persistence')
    assert.match(capped.content.map((block: any) => block.text ?? '').join('\n'), /Found 2 of 20 matches/iu)
    assert.ok(h.savedSpill, 'capped native result should be saved through the spill seam')
    assert.match(h.savedSpill.content, /needle-19/u)

    const controller = new AbortController()
    const subprocess: any = h.ctx.get('subprocess', false)
    const originalSpawn = subprocess.spawn
    let spawned = 0
    subprocess.spawn = (...args: any[]) => {
      spawned += 1
      const handle = originalSpawn.apply(subprocess, args)
      controller.abort()
      return handle
    }
    try {
      await writeFile(join(h.root, 'large-cancel.txt'), 'needle\n' + 'x'.repeat(10 * 1024 * 1024))
      const cancelled = await h.execute({ pattern: 'needle', path: 'large-cancel.txt' }, controller.signal) as any
      assert.equal(spawned, 1, 'cancellation test must create a real native subprocess')
      assert.equal(cancelled.isError, true, JSON.stringify(cancelled))
      assert.equal(cancelled.error?.info?.code, 'SEARCH_ABORTED')
      assert.doesNotMatch(cancelled.content.map((block: any) => block.text ?? '').join('\n'), /cannot search/u)
    } finally {
      subprocess.spawn = originalSpawn
    }
  } finally { await h.close() }
})

test('native grep guard denial does not invoke ripgrep', native, async () => {
  const h = await createHarness()
  try {
    const subprocess: any = h.ctx.get('subprocess', false)
    const originalSpawn = subprocess.spawn
    let spawned = 0
    subprocess.spawn = (...args: any[]) => { spawned += 1; return originalSpawn.apply(subprocess, args) }
    const release = h.tools.guard(() => 'native grep denied by fixture policy')
    const result = await h.execute({ pattern: 'needle' }) as any
    release()
    assert.equal(result.isError, true, JSON.stringify(result))
    assert.match(result.content.map((block: any) => block.text ?? '').join('\n'), /native grep denied by fixture policy/u)
    assert.equal(spawned, 0, 'guard denial must prevent subprocess execution')
    subprocess.spawn = originalSpawn
  } finally { await h.close() }
})
