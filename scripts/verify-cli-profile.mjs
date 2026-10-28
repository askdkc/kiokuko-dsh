/** Real isolated add/update + PTY startup/input/cancel/Lisp/resume acceptance.
 * Supply already-built tarballs; this script never builds or reads live settings.
 * node scripts/verify-cli-profile.mjs DSH_BIN CLI_TGZ KIOKUKO_TGZ NODE_PTY XTERM_ANCHOR [WORK_ROOT] [all|install|tui|source]
 */
import assert from 'node:assert/strict'
import { selectedDshRuntime } from './dsh-fixture-identity.mjs'
import { createInputBarrier, inputWasHandled, questionWasAnswered, createQuestionSelection } from './cli-input-barrier.mjs'
import { completeVerification } from './verification-completion.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { appendFileSync, readFileSync, statSync } from 'node:fs'
import { createConnection } from 'node:net'
import { mkdir, mkdtemp, readFile, writeFile, realpath, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import YAML from 'yaml'

const [dshArg, cliArg, kiokukoArg, ptyArg, xtermArg, rootArg, stage = 'all'] = process.argv.slice(2)
assert.ok(['all', 'install', 'tui', 'source'].includes(stage))
assert.ok(dshArg && cliArg && kiokukoArg && ptyArg && xtermArg, 'Expected DSH_BIN CLI_TGZ KIOKUKO_TGZ NODE_PTY XTERM_ANCHOR [WORK_ROOT]')
const [dsh, cliPackage, kiokukoPackage] = await Promise.all([dshArg, cliArg, kiokukoArg].map(path => realpath(resolve(path))))
const requestedRoot = rootArg && rootArg !== '-' ? resolve(rootArg) : await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'kcp-'))
if (rootArg && rootArg !== '-' && stage !== 'tui') await mkdir(requestedRoot, { recursive: false, mode: 0o700 })
const root = await realpath(requestedRoot)
let sourceHook = process.env.KIOKUKO_CLI_SOURCE_HOOK ? await realpath(process.env.KIOKUKO_CLI_SOURCE_HOOK) : undefined
if (sourceHook) {
  assert.ok(['tui', 'source'].includes(stage), 'Source-entry mode cannot install packages')
  assert.ok(sourceHook.startsWith(`${root}/`), 'Source-entry hook must be a private artifact inside WORK_ROOT')
}
const home = join(root, 'home'), dshHome = join(root, 'dsh'), workspace = join(root, 'workspace')
assert.ok(process.platform !== 'darwin' || Buffer.byteLength(join(home, '.dsh-cli/inject/00000000-0000-0000-0000-000000000000.sock')) < 104,
  'Use a short WORK_ROOT: macOS Unix sockets are limited to 103 path bytes')
for (const path of [home, dshHome, workspace, join(root, 'tmp'), join(root, 'cache')]) await mkdir(path, { recursive: true, mode: 0o700 })
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, SHELL: process.env.SHELL ?? '/bin/sh',
  TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'), XDG_CACHE_HOME: join(root, 'cache'),
  DSH_HOME: dshHome, DSH_CLI_SESSION_ROOT: join(root, 'sessions'), DSH_CLI_WORKSPACE_TARGET: workspace,
  KIOKUKO_DATA_DIR: join(root, 'kiokuko'), KIOKUKO_CLI_PROBE_EVENTS: join(root, 'events.jsonl'),
  DSH_TELEMETRY_MODE: 'DISABLED', DSH_TELEMETRY_DISABLED: '1', DSH_CLI_LANG: 'en',
  npm_config_cache: join(root, 'cache/npm'), npm_config_store_dir: join(root, 'cache/pnpm'),
  npm_config_userconfig: join(root, 'empty.npmrc'), NODE_ENV: 'production', TERM: 'xterm-256color', LANG: 'en_US.UTF-8' }
await writeFile(env.npm_config_userconfig, '', { mode: 0o600 })
// Source-entry acceptance imports already installed packages and the current build.
// Explicit patch overlays exercise source entries without a package-manager operation.
let sourcePackages
const sourcePatches = []
if (stage === 'source') {
  const selected = selectedDshRuntime(resolve(import.meta.dirname, '..'))
  assert.equal(dsh, await realpath(join(selected.packageRoot, '@deepseek-ai/dsh/lib/bin.js')), 'CLI source acceptance must use the selected official executable')
  const hostAnchor = join(selected.packageRoot, '..', 'package.json')
  const cli = JSON.parse(await readFile(cliPackage, 'utf8'))
  const plugin = JSON.parse(await readFile(kiokukoPackage, 'utf8'))
  assert.equal(cli.name, '@askdkc/dsh-cli', 'source mode requires the actual CLI package manifest')
  assert.equal(plugin.name, 'kiokuko-dsh')
  sourcePackages = { '@askdkc/dsh-cli': dirname(cliPackage), 'kiokuko-dsh': dirname(kiokukoPackage) }
  const profile = join(dshHome, 'profiles/dsh-cli')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true,
    name: 'isolated-cli-source-acceptance', dependencies: { '@askdkc/dsh-cli': cli.version, 'kiokuko-dsh': plugin.version },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }) + '\n')
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  for (const [directory, manifest] of [[dirname(cliPackage), cli], [dirname(kiokukoPackage), plugin]]) {
    const patches = manifest.dsh?.bundle?.patch
    assert.ok(typeof patches === 'string' || Array.isArray(patches), 'A real bundle patch is required')
    for (const patch of [patches].flat()) sourcePatches.push('--patch', await realpath(resolve(directory, patch)))
  }
  sourceHook = join(root, 'source-entry.mjs')
  await writeFile(sourceHook, `import { registerHooks } from 'node:module';
import { join } from 'node:path'; import { pathToFileURL } from 'node:url';
const roots = ${JSON.stringify(sourcePackages)};
const coreAnchor = ${JSON.stringify(hostAnchor)};
registerHooks({ resolve(specifier, context, nextResolve) {
  for (const [name, directory] of Object.entries(roots)) {
    if (specifier === name || specifier.startsWith(name + '/'))
      return nextResolve(specifier, { ...context, parentURL: pathToFileURL(join(directory, 'package.json')).href });
  }
  if (specifier.startsWith('@deepseek-ai/')) return nextResolve(specifier, { ...context, parentURL: pathToFileURL(coreAnchor).href });
  return nextResolve(specifier, context);
}});
`)
}
const exec = promisify(execFile), steps = []
async function command(label, args, allowFailure = false) {
  console.log(`Starting ${label}`)
  let result
  try { result = await exec(process.execPath, [...(sourceHook ? ['--import', sourceHook] : []), dsh, ...args, ...sourcePatches], { cwd: workspace, env, timeout: 180000, maxBuffer: 16 * 1024 * 1024 }) }
  catch (error) { result = error; if (!allowFailure) { await writeFile(join(root, `${label}.log`), `${error.stdout ?? ''}\n${error.stderr ?? ''}`); throw error } }
  await writeFile(join(root, `${label}.log`), `${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  steps.push({ label, exitCode: result.code ?? 0 })
  console.log(`Completed ${label}: ${result.code ?? 0}`)
  return result
}
const manifestPath = join(dshHome, 'profiles/dsh-cli/package.json')
const manifest = () => JSON.parse(readFileSync(manifestPath, 'utf8'))
if (!['tui', 'source'].includes(stage)) {
await command('add-cli', ['plugin', '--profile', 'dsh-cli', 'add', cliPackage])
await command('update-missing', ['plugin', '--profile', 'dsh-cli', 'update', 'kiokuko-dsh', '--latest'], true)
assert.equal(manifest().dependencies?.['kiokuko-dsh'], undefined, 'update is not an initial installation')
await command('add-kiokuko', ['plugin', '--profile', 'dsh-cli', 'add', 'kiokuko-dsh'])
const beforeUpdate = { dependency: manifest().dependencies?.['kiokuko-dsh'],
  package: JSON.parse(await readFile(join(dshHome, 'profiles/dsh-cli/node_modules/kiokuko-dsh/package.json'), 'utf8')) }
assert.ok(!beforeUpdate.dependency.startsWith('file:'), 'Registry installation must precede the latest update')
const bundles = manifest().dsh.profile.bundles
for (const name of ['@deepseek-ai/dsh-base', '@askdkc/dsh-cli', 'kiokuko-dsh']) assert.equal(bundles.filter(item => item === name).length, 1, name)
const sentinel = join(root, 'sessions/preserve-sentinel.txt')
await mkdir(dirname(sentinel), { recursive: true }); await writeFile(sentinel, 'keep\n')
const profilePatch = join(dshHome, 'profiles/dsh-cli/cordis.patch.yml')
const savedPatch = await readFile(profilePatch, 'utf8')
await command('update-installed', ['plugin', '--profile', 'dsh-cli', 'update', 'kiokuko-dsh', '--latest'])
const afterUpdate = { dependency: manifest().dependencies?.['kiokuko-dsh'],
  package: JSON.parse(await readFile(join(dshHome, 'profiles/dsh-cli/node_modules/kiokuko-dsh/package.json'), 'utf8')) }
assert.ok(!afterUpdate.dependency.startsWith('file:'), 'Latest update must retain a registry dependency')
assert.equal(await readFile(sentinel, 'utf8'), 'keep\n')
assert.equal(await readFile(profilePatch, 'utf8'), savedPatch)
assert.deepEqual(manifest().dsh.profile.bundles, bundles)
await command('restore-fixed-tarball', ['plugin', '--profile', 'dsh-cli', 'add', kiokukoPackage])
await writeFile(join(root, 'install-report.json'), JSON.stringify({ steps, beforeUpdate, afterUpdate, manifest: manifest() }, null, 2) + '\n')
if (stage === 'install') { console.log(`Install phase passed: ${root}`); process.exit(0) }
} else if (stage === 'tui' && !sourceHook) steps.push(...JSON.parse(await readFile(join(root, 'install-report.json'), 'utf8')).steps)
const dumped = await command('dump-config', ['--profile', 'dsh-cli', '--dump-config'])
const rows = YAML.parse(dumped.stdout, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] })
assert.equal(rows.filter(row => row.id === 'kiokuko-dsh' && row.disabled !== true).length, 1)
const cli = rows.find(row => row.id === 'dsh-cli')
assert.ok(cli)
const fixture = resolve(import.meta.dirname, 'cli-profile-fixture.mjs')
const trace = resolve(import.meta.dirname, 'cli-profile-trace.mjs')
const overlay = join(root, 'probe.patch.yml')
await writeFile(overlay, YAML.stringify([
  { id: 'kiokuko-dsh', config: { enabled: true, typedDecisions: { mode: 'off' }, memoryReview: { mode: 'off' },
    memoryEvolution: { mode: 'off' }, agenticReplay: { enabled: false }, lisp: { enabled: true } } },
  { insert: [{ id: 'kiokuko-cli-profile-fixture', name: fixture, inject: ['llm', 'agents', 'sessions', 'tools', 'commands'] }] },
  { id: 'dsh-cli', inject: [...cli.inject, 'kiokukoProfileFixture'], config: { provider: 'kiokuko-profile-fixture', model: 'fixture',
    fullscreen: true, terminalImages: false, smoothStreaming: false, whale: false, activity: false, cwd: workspace } },
]))
const pty = createRequire(resolve(ptyArg))('node-pty')
const { Terminal } = createRequire(resolve(xtermArg))('@xterm/headless')
const events = () => {
  try { return readFileSync(env.KIOKUKO_CLI_PROBE_EVENTS, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch { return [] }
}
async function until(predicate, description, timeoutMs = 30000, onTick = () => {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { onTick(); if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)) }
  assert.ok(predicate(), description)
}
const launches = []
async function tui(resumeSessionId) {
  const start = events().length
  const launch = { resumed: Boolean(resumeSessionId), startedAt: Date.now() }
  launches.push(launch)
  const child = pty.spawn(process.execPath, ['--import', trace, ...(sourceHook ? ['--import', sourceHook] : []), dsh, '--profile', 'dsh-cli', ...sourcePatches, '--patch', overlay, ...(resumeSessionId ? ['--resume', resumeSessionId] : [])], {
    name: 'xterm-256color', cols: 110, rows: 34, cwd: workspace, env,
  })
  const terminal = new Terminal({ cols: 110, rows: 34, scrollback: 2000, allowProposedApi: true })
  let output = '', exit, outputOffset = 0, renderedFrame = 0, inputSequence = 0
  terminal.onData(data => { if (!exit) child.write(data) })
  child.onData(data => { outputOffset += Buffer.byteLength(data); output = (output + data).slice(-2 * 1024 * 1024); terminal.write(data, () => { renderedFrame++ }) })
  child.onExit(value => { exit = value })
  const fresh = () => events().slice(start)
  const screen = () => Array.from({ length: 34 }, (_, index) => terminal.buffer.active.getLine(terminal.buffer.active.baseY + index)?.translateToString(true) ?? '').join('\n')
  const composerText = () => {
    const rows = screen().split('\n')
    const input = rows.findLastIndex(row => row.includes('⌸ ❯ '))
    if (input < 0) return undefined
    const end = rows.findIndex((row, index) => index > input && row.includes('╰'))
    if (end < 0) return undefined
    return rows.slice(input, end).map((row, index) => (index === 0 ? row.slice(row.indexOf('❯ ') + 2) : row)
      .replace(/\s*⛶\s*$/, '').trim()).join('')
  }
  // Wait for a post-write UI acknowledgement before starting the debounce
  // interval. A delayed PTY read must not consume the interval before handling.
  const inputBarrier = createInputBarrier()
  const enterReady = () => inputBarrier.ready()
  const enter = handled => { inputBarrier.submitted(handled); child.write('\r') }
  const answerQuestion = (request, selected, onAnswered = () => {}) => {
    const eventOffset = fresh().length
    enter(() => {
      if (!questionWasAnswered({ events: fresh(), eventOffset, requestSequence: request.requestSequence,
        questionId: request.questions[0].id, selected: [selected] })) return false
      onAnswered()
      return true
    })
  }
  const selections = new Map()
  const selectQuestion = (request, selected, onAnswered = () => {}) => {
    if (!enterReady()) return
    let selection = selections.get(request.requestSequence)
    if (!selection) {
      selection = createQuestionSelection(request.questions[0], selected)
      selections.set(request.requestSequence, selection)
    }
    const latest = fresh().filter(value => value.type === 'native-question').at(-1)
    const active = latest?.requestSequence === request.requestSequence && !fresh().some(value =>
      value.type === 'native-question-response' && value.requestSequence === request.requestSequence)
    const action = selection({ screen: screen(), frame: renderedFrame, active })
    if (!action) return
    appendFileSync(env.KIOKUKO_CLI_PROBE_EVENTS, JSON.stringify({ type: 'probe-observation', name: 'questionSelection',
      requestSequence: request.requestSequence, selected, action, frame: renderedFrame, time: Date.now() }) + '\n')
    if (action === 'submit') answerQuestion(request, selected, onAnswered)
    else child.write(action === 'down' ? '\x1b[B' : '\x1b[A')
  }
  const declinedQuestions = new Set()
  const wait = (predicate, description, timeoutMs) => until(predicate, description, timeoutMs, () => {
    const ready = enterReady()
    const request = fresh().filter(value => value.type === 'native-question').at(-1)
    const question = request?.questions?.[0]
    if (question?.detail !== 'The task is complete. May I organize its recorded experience into proposed memories? Nothing is saved until you review and approve it.'
      || declinedQuestions.has(request.requestSequence) || !ready) return
    assert.deepEqual(question.options.map(option => option.label), ['整理して確認する', '今回は保存しない'])
    selectQuestion(request, '今回は保存しない', () => {
      declinedQuestions.add(request.requestSequence)
      appendFileSync(env.KIOKUKO_CLI_PROBE_EVENTS, JSON.stringify({ type: 'probe-observation', name: 'memoryReviewDeclined', requestSequence: request.requestSequence, questionId: question.id, time: Date.now() }) + '\n')
    }) // Decline once through the native UI; confirmation requires its matching answer.
  })
  const discovery = join(home, '.dsh-cli/inject/servers.json')
  const endpoint = () => { try { return JSON.parse(readFileSync(discovery, 'utf8')).find(server => server.pid === child.pid && statSync(server.socketPath).isSocket()) } catch { return undefined } }
  const observe = (name, details = {}) => {
    const time = Date.now()
    launch[name] = time
    appendFileSync(env.KIOKUKO_CLI_PROBE_EVENTS, JSON.stringify({ type: 'probe-observation', name, time, pid: child.pid, ...details }) + '\n')
  }
  async function typeInput(text) {
    await wait(enterReady, 'previous Enter was not acknowledged and settled')
    await wait(() => composerText() === '', 'composer did not clear the previous input')
    const input = { id: `${child.pid}:${++inputSequence}`, text, eventOffset: fresh().length, outputOffset, frame: renderedFrame }
    observe('inputSent', { ...input })
    child.write(text)
    await wait(() => renderedFrame > input.frame && composerText() === text, `TUI did not freshly echo ${text} in its composer`)
    observe('inputEchoed', { inputId: input.id, text, outputOffset, frame: renderedFrame })
    return input
  }
  async function submitInput(input, beforeSubmit = () => {}) {
    await wait(enterReady, 'native Enter debounce window did not close')
    beforeSubmit()
    observe('inputSubmitted', { inputId: input.id, text: input.text, outputOffset, frame: renderedFrame })
    const frame = renderedFrame, eventOffset = fresh().length
    // A question panel can replace the composer before its empty frame is
    // sampled. Its fresh native question plus rendered takeover also proves
    // handling, without treating arbitrary output as an acknowledgement.
    enter(() => inputWasHandled({ exited: exit, submittedFrame: frame, frame: renderedFrame, composer: composerText(),
      freshQuestionVisible: fresh().slice(eventOffset).some(value => value.type === 'native-question'
        && value.questions?.some(question => question.options?.some(option => screen().includes(option.label)))) }))
    return input
  }
  async function line(text) {
    await wait(() => {
      const request = fresh().filter(value => value.type === 'native-question').at(-1)
      return !request?.questions?.[0]?.detail?.startsWith('The task is complete. May I organize')
        || declinedQuestions.has(request.requestSequence)
    }, 'native memory-review prompt did not close')
    const input = await typeInput(text)
    return await submitInput(input)
  }
  const native = type => fresh().filter(value => value.type === 'native-event' && value.event.type === type)
  try {
    await wait(() => exit || endpoint(), 'post-render injection endpoint missing')
    assert.equal(exit, undefined, `TUI exited before ready: ${output.slice(-3000)}`)
    const server = endpoint()
    assert.ok(server)
    await new Promise((resolve, reject) => {
      const socket = createConnection(server.socketPath)
      socket.setTimeout(3000)
      socket.once('connect', () => { socket.end(); resolve() })
      socket.once('error', reject)
      socket.once('timeout', () => socket.destroy(new Error('TUI injection socket did not connect')))
    })
    observe('socketConnectedAt', { sessionId: server.sessionId })
    assert.ok(fresh().some(value => value.type === 'fixture-loaded' && value.stdoutTTY && value.stdinTTY), 'real TTY required')
    await wait(() => fresh().some(value => value.type === 'agent-created'), 'TUI did not create agent')
    const created = fresh().find(value => value.type === 'agent-created')
    launch.sessionId = created.sessionId
    assert.equal(created.executionFences, true, 'CLI execution fences must be mounted')
    if (resumeSessionId) { assert.equal(created.sessionId, resumeSessionId); assert.ok(created.eventCount > 0, 'resumed history is empty') }
    // Registration observations below are diagnostic only. Never wait for Kiokuko
    // before exercising the first input that the real TUI visibly accepts.
    const firstCommand = '/kioku-lisp status'
    observe('firstInputSentAt', { text: firstCommand })
    const firstInput = await typeInput(firstCommand)
    observe('firstInputEchoAt')
    await submitInput(firstInput, () => observe('firstSubmitAt'))
    await wait(() => {
      const fallback = native('user/message').find(value => value.time >= launch.firstSubmitAt && value.event.data.source?.kind === 'user'
        && value.event.data.content?.some(block => block.text === firstCommand))
      assert.equal(fallback, undefined, 'The first Kiokuko slash command was submitted as an ordinary model message')
      assert.ok(!fresh().some(value => value.type === 'fixture-request' && value.time >= launch.firstSubmitAt && value.text === firstCommand),
        'The first Kiokuko slash command reached the model')
      return native('command/done').some(value => value.time >= launch.firstSubmitAt)
    }, 'The first Kiokuko slash command did not complete')
    const firstRun = native('command/run').find(value => value.time >= launch.firstSubmitAt)
    const firstDone = native('command/done').find(value => value.event.data.commandId === firstRun?.event.data.commandId)
    assert.equal(firstRun?.event.data.name, 'kioku-lisp')
    assert.equal(firstRun.event.data.args.trim(), 'status')
    assert.equal(firstDone?.event.data.kind, 'success', JSON.stringify(firstDone))
    observe('firstCommandCompletedAt', { commandId: firstRun.event.data.commandId })
    const taskChecks = []
    const taskCommand = async (args, expectedKind = 'success') => {
      const input = await line(`/kioku-task ${args}`)
      let run, completion
      await wait(() => {
        run = fresh().slice(input.eventOffset).filter(value => value.type === 'native-event' && value.event.type === 'command/run').find(value => value.event.data.name === 'kioku-task' && (value.event.data.args === undefined || value.event.data.args.trim() === args))
        completion = run && native('command/done').find(value => value.sessionId === run.sessionId && value.event.data.commandId === run.event.data.commandId)
        return completion
      }, `Task command did not complete: ${args}`, 90000)
      const done = completion.event.data
      assert.equal(done.kind, expectedKind, JSON.stringify(done))
      if (expectedKind !== 'success') return done
      const value = JSON.parse(done.text)
      taskChecks.push({ command: args, inputId: input.id, commandId: run.event.data.commandId, sessionId: run.sessionId, value })
      return value
    }
    let resumedTaskId
    const recovery = { required: false, blockedInput: false, command: null }
    if (resumeSessionId) {
      const restored = (await taskCommand('status')).task
      assert.ok(restored, 'CLI resume must restore the persisted task')
      assert.equal(restored.state, 'Pending')
      assert.equal(restored.sessionId, resumeSessionId)
      const continued = await taskCommand(`resume ${restored.taskId}`)
      assert.equal(continued.taskId, restored.taskId)
      assert.equal(continued.state, 'Working')
      resumedTaskId = restored.taskId
      // Task state changes do not restore an independent protected Lisp binding.
      // A cold primary continuation may retain only its ancestor's protection.
      if (firstDone.event.data.text.includes('Lisp: DISABLED')) {
        recovery.required = true
        const blockedText = 'profile-fixture-protected-resume'
        const previousEnds = native('turn/end').length
        await line(blockedText)
        await wait(() => native('turn/end').slice(previousEnds).some(value => value.event.data.reason.kind === 'blocked'), 'unrecovered protection did not block the native step')
        assert.ok(!native('user/message').some(value => value.event.data.content?.some(block => block.text === blockedText)), 'blocked input must not be appended as an admitted user message')
        assert.ok(!fresh().some(value => value.type === 'fixture-request' && value.text === blockedText), 'blocked input must not reach the provider')
        recovery.blockedInput = true
        const previousRuns = native('command/run').length
        await line('/kioku-lisp enable')
        let enabled
        await wait(() => {
          const run = native('command/run').slice(previousRuns).find(value => value.event.data.name === 'kioku-lisp')
          enabled = run && native('command/done').find(value => value.event.data.commandId === run.event.data.commandId)
          return enabled
        }, 'displayed native Lisp recovery command did not complete', 90000)
        assert.equal(enabled.event.data.kind, 'success', JSON.stringify(enabled))
        assert.match(enabled.event.data.text, /Lisp: (?:READY|TASK_READY)/)
        recovery.command = '/kioku-lisp enable'
      }

    }
    const hello = resumeSessionId ? 'profile-fixture-hello-resume' : 'profile-fixture-hello-initial'
    await line(hello)
    await wait(() => native('user/message').some(value => value.event.data.source?.kind === 'user' && value.event.data.content?.some(block => block.text === hello)), 'new native human input missing')
    const human = native('user/message').find(value => value.event.data.source?.kind === 'user' && value.event.data.content?.some(block => block.text === hello))
    await wait(() => fresh().some(value => value.type === 'fixture-request' && value.text === hello), 'new human input did not reach model')
    await wait(() => native('assistant/message').some(value => value.event.seq > human.event.seq && JSON.stringify(value.event.data).includes('PROFILE_FIXTURE_OK')), 'new native answer missing')
    const answer = native('assistant/message').find(value => value.event.seq > human.event.seq && JSON.stringify(value.event.data).includes('PROFILE_FIXTURE_OK'))
    await wait(() => native('turn/end').some(value => value.event.seq > answer.event.seq && value.event.data.reason.kind === 'completed'), 'new answer turn did not complete')
    await wait(() => screen().includes('PROFILE_FIXTURE_OK'), 'answer did not render')
    if (resumedTaskId) {
      await taskCommand(`ignore ${resumedTaskId} --reason Isolated acceptance completed`)
      await wait(() => fresh().some(value => value.type === 'task-state' && value.task.taskId === resumedTaskId && value.task.state === 'Ignore'), 'Resumed task did not confirm Ignore')
    }
    let finalSessionId = created.sessionId
    if (!resumeSessionId) {
      await line('profile-fixture-slow')
      await wait(() => fresh().some(value => value.type === 'fixture-slow-started'), 'slow fixture did not start')
      child.write('\x1b')
      await wait(() => fresh().some(value => value.type === 'fixture-aborted'), 'Esc did not abort native request')
      await wait(() => native('turn/end').some(value => value.event.data.reason.kind === 'aborted'), 'cancelled turn did not converge')
      for (const action of ['enable', 'status']) {
        const before = native('command/done').length
        await line(`/kioku-lisp ${action}`)
        await wait(() => native('command/done').length > before, `Lisp ${action} did not complete`, 90000)
        const done = native('command/done').at(-1).event.data
        assert.equal(done.kind, 'success', JSON.stringify(done))
      }
      const lispRequest = `profile-fixture-lisp ${created.sessionId.slice(0, 8)}: evaluate (+ 20 22) using Lisp`
      const completionReviewOffset = fresh().length
      await line(lispRequest)
      await wait(() => {
        if (enterReady() && screen().includes('この作業をどう実行しますか') && screen().includes('通常実行')) {
          const request = fresh().filter(value => value.type === 'native-question').at(-1)
          if (request?.questions[0]?.id === 'enno-execution-mode') selectQuestion(request, '通常実行')
        }
        return fresh().some(value => value.type === 'fixture-lisp-consumed' && value.text === lispRequest && value.sessionId === created.sessionId)
      }, 'Lisp result was not consumed by the native model', 90000)
      const consumed = fresh().find(value => value.type === 'fixture-lisp-consumed' && value.text === lispRequest && value.sessionId === created.sessionId)
      assert.notEqual(consumed.result.isError, true, JSON.stringify(consumed))
      assert.match(JSON.stringify(consumed.result), /42/)
      const receipt = fresh().find(value => value.type === 'native-tool-result' && value.callId === 'profile-fixture-lisp-eval')
      assert.ok(receipt, 'Native Lisp tool receipt is required')
      assert.equal(receipt.result.isError, false, JSON.stringify(receipt))
      assert.equal(receipt.result.value.ok, true, JSON.stringify(receipt))
      await wait(() => screen().includes('PROFILE_LISP_OK'), 'Lisp answer did not render')
      const lispInput = native('user/message').find(value => value.sessionId === created.sessionId && value.event.data.content?.some(block => block.text === lispRequest))
      assert.ok(lispInput, 'Lisp input must be recorded in the same session')
      await wait(() => {
        const completed = native('turn/end').find(value => value.sessionId === created.sessionId && value.event.seq > lispInput.event.seq && value.event.data.reason.kind === 'completed')
        return completed && native('plugin:kiokuko-dsh/repository-learning').some(value => value.sessionId === created.sessionId
          && value.event.data.turn === completed.event.data.turn && value.event.data.phase === 'capture'
          && value.event.data.status === 'saved' && value.event.data.reflection === 'model') && enterReady()
      }, 'completed native Lisp turn did not save automatic repository learning')
      await wait(() => {
        const review = fresh()
          .slice(completionReviewOffset)
          .find(
            (value) =>
              value.type === 'native-question' &&
              value.questions?.[0]?.detail ===
                'The task is complete. May I organize its recorded experience into proposed memories? Nothing is saved until you review and approve it.',
          )
        return review && declinedQuestions.has(review.requestSequence) && enterReady() && composerText() === ''
      }, 'managed Lisp task completion review did not settle before the next composer input')
      const beforeCancel = native('command/done').length
      await line('/kioku-lisp cancel')
      await wait(() => native('command/done').length > beforeCancel, 'Lisp cancel did not complete', 90000)
      assert.equal(native('command/done').at(-1).event.data.kind, 'success')
      const current = (await taskCommand('status')).task
      if (current && !['Done', 'Ignore'].includes(current.state)) {
        await taskCommand(`ignore ${current.taskId} --reason Finished the isolated Lisp check`)
        await wait(() => fresh().some(value => value.type === 'task-state' && value.task.taskId === current.taskId && value.task.state === 'Ignore'), 'Existing task did not confirm stop')
      }
      const createdTask = await taskCommand('create research Inspect the isolated profile task state')
      assert.equal(createdTask.state, 'ToDo')
      const startedTask = await taskCommand(`start ${createdTask.taskId}`)
      assert.equal(startedTask.state, 'Working')
      const rejectedDone = await taskCommand(`complete ${createdTask.taskId}`, 'error')
      assert.match(rejectedDone.text, /evidence|receipt|verification|証拠|根拠/iu, 'Done must reject for missing evidence')
      const afterRejectedDone = (await taskCommand('status')).task
      assert.equal(afterRejectedDone.taskId, startedTask.taskId)
      assert.equal(afterRejectedDone.state, 'Working')
      assert.equal(afterRejectedDone.revision, startedTask.revision)
      assert.equal(afterRejectedDone.generation, startedTask.generation)
      await taskCommand(`wait ${createdTask.taskId}`)
      await wait(() => fresh().some(value => value.type === 'task-state' && value.task.taskId === createdTask.taskId && value.task.state === 'Pending'), 'Task wait did not confirm native and Lisp stop')
      const resumedTask = await taskCommand(`resume ${createdTask.taskId}`)
      assert.equal(resumedTask.state, 'Working')
      assert.ok(resumedTask.generation > startedTask.generation)
      await line('/model kiokuko-profile-fixture/fixture-next')
      await wait(() => fresh().some(value => value.type === 'agent-created' && value.sessionId !== created.sessionId), 'Model change did not create a primary continuation', 90000)
      await wait(() => fresh().some(value => value.type === 'task-state' && value.task.taskId === createdTask.taskId && value.task.sessionId !== created.sessionId), 'Model change did not transfer the canonical task', 90000)
      const afterSwitch = (await taskCommand('status')).task
      assert.equal(afterSwitch.taskId, createdTask.taskId)
      assert.notEqual(afterSwitch.sessionId, created.sessionId)
      assert.ok(afterSwitch.generation > resumedTask.generation)
      finalSessionId = afterSwitch.sessionId
      await taskCommand(`wait ${createdTask.taskId}`)
      await wait(() => fresh().some(value => value.type === 'task-state' && value.task.taskId === createdTask.taskId && value.task.sessionId === finalSessionId && value.task.state === 'Pending'), 'Transferred task did not stop')
    }
    await line('/quit')
    await wait(() => exit, '/quit did not exit', 30000)
    assert.equal(exit.exitCode, 0)
    assert.ok(output.includes('\x1b[?25h'), 'cursor not restored')
    assert.doesNotMatch(output, /skipping the interactive CLI|plugin tree failed to load|UnhandledPromiseRejection/)
    assert.equal(fresh().filter(value => value.type === 'native-error').length, 0, JSON.stringify(fresh().filter(value => value.type === 'native-error')))
    return { sessionId: finalSessionId, initialSessionId: created.sessionId, taskChecks, recovery, eventCount: created.eventCount, resumed: Boolean(resumeSessionId), exitCode: exit.exitCode,
      commandReadyMs: fresh().find(value => value.type === 'native-commands' && value.names.includes('kioku-lisp')).time - created.time,
      humanSeq: human.event.seq, answerSeq: answer.event.seq }
  } finally {
    launch.commandRegisteredAt = fresh().find(value => value.type === 'native-commands' && value.sessionId === launch.sessionId && value.names.includes('kioku-lisp'))?.time ?? null
    await writeFile(join(root, resumeSessionId ? 'resume-terminal.log' : 'terminal.log'), output)
    await writeFile(join(root, resumeSessionId ? 'resume-screen.txt' : 'screen.txt'), screen())
    if (!exit) { child.kill(); try { await wait(() => exit, 'PTY cleanup', 5000) } catch { child.kill('SIGKILL') } }
    terminal.dispose()
  }
}
console.log(`Isolated ${sourceHook ? 'source-entry profile' : 'installed profile'} at ${root}; starting actual PTY`)
const runtimeInventory = () => [...new Map(events().filter(value => value.type === 'runtime-package').map(value => [value.manifest, value])).values()]
async function retainEvidence() {
  if (process.env.KIOKUKO_VERIFY_COMPLETION_FILE) {
    const evidence = dirname(process.env.KIOKUKO_VERIFY_COMPLETION_FILE)
    await mkdir(evidence, { recursive: true })
    for (const file of ['report.json', 'events.jsonl', 'dump-config.log', 'terminal.log', 'resume-terminal.log', 'screen.txt', 'resume-screen.txt']) {
      try { await copyFile(join(root, file), join(evidence, file)) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
}
const baseReport = { root, mode: sourceHook ? 'source-entry' : 'installed-package', ...(sourceHook ? { sourceHook, sourcePackages, installation: 'not exercised; no package operations attempted' } : {}), model: 'scripted offline fixture; no real model inference', readiness: 'real TUI socket and input echo; no Kiokuko registration wait', steps }
await writeFile(join(root, 'report.json'), JSON.stringify({ ...baseReport, status: 'running' }, null, 2) + '\n')
try {
  const initial = await tui()
  const resumed = await tui(initial.sessionId)
  const report = { ...baseReport, status: 'passed', initial, resumed, launches, runtimePackages: runtimeInventory() }
  const cliRuntime = report.runtimePackages.find(item => item.name === '@askdkc/dsh-cli')
  assert.ok(cliRuntime, 'Actual interactive CLI package load must be observed')
  if (stage === 'source') assert.equal(cliRuntime.version, JSON.parse(await readFile(cliPackage, 'utf8')).version)
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  await retainEvidence()
  completeVerification({ profile: 'dsh-cli', interactive: true, cliVersion: cliRuntime.version, sourceEntry: Boolean(sourceHook) })
  console.log(JSON.stringify({ ...report, runtimePackages: `${report.runtimePackages.length} packages recorded in report.json` }))
  process.exit(0)
} catch (error) {
  await writeFile(join(root, 'report.json'), JSON.stringify({ ...baseReport, status: 'failed', launches, error: String(error.stack ?? error), runtimePackages: runtimeInventory() }, null, 2) + '\n')
  await retainEvidence()
  throw error
}
