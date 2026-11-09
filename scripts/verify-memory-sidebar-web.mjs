import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { transform } from 'esbuild'
import { chromium } from 'playwright'
import { selectedDshRuntime } from './dsh-fixture-identity.mjs'
import { answerTaskStartupForTest, installFixtureQuestionAnswers } from './lib/web-test-navigation.mjs'
import { webTestPort } from './test-web-port.mjs'
import { completeVerification } from './verification-completion.mjs'

const root = resolve(import.meta.dirname, '..')
const { packageRoot, environment, manifest } = selectedDshRuntime(root)
const exec = promisify(execFile)
const base = await realpath(await mkdtemp(join(tmpdir(), 'memory-sidebar-web-')))
const project = join(base, 'project')
const env = { ...environment, HOME: join(base, 'home'), DSH_HOME: join(base, 'dsh'),
  KIOKUKO_DATA_DIR: join(base, 'data'), npm_config_cache: join(base, 'cache') }
let host, browser, page, logs = ''

async function waitForUrl() {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline && host.exitCode === null) {
    const url = logs.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0]
    if (url) return url
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The isolated DSH Web host did not start')
}

try {
  for (const path of [project, env.HOME, env.DSH_HOME, env.KIOKUKO_DATA_DIR]) await mkdir(path)
  await exec('git', ['init', '-q'], { cwd: project })
  const archive = process.env.KIOKUKO_VERIFY_TARBALL ?? join(base, JSON.parse((await exec('npm',
    ['pack', '--ignore-scripts', '--pack-destination', base, '--json'],
    { cwd: root, env: { ...env, npm_config_offline: 'true' } })).stdout)[0].filename)

  // Test the packed entry in the official Web profile with the already staged
  // dependency graph. Package installation has its own pack-check gate.
  const profile = join(env.DSH_HOME, 'profiles/web')
  const installed = join(profile, 'node_modules/kiokuko-dsh')
  const boot = await import(pathToFileURL(join(packageRoot, '@deepseek-ai/dsh-app-boot/lib/index.js')).href)
  boot.initProfile(profile, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'kiokuko-dsh'])
  const dependencies = join(installed, 'node_modules')
  await mkdir(dependencies, { recursive: true })
  await exec('tar', ['-xf', archive, '--strip-components=1', '-C', installed])
  await symlink(join(packageRoot, '@deepseek-ai'), join(dependencies, '@deepseek-ai'), 'dir')
  for (const entry of await readdir(join(root, 'node_modules'))) {
    if (!entry.startsWith('.') && entry !== '@deepseek-ai') await symlink(join(root, 'node_modules', entry), join(dependencies, entry))
  }
  const profileManifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  profileManifest.dependencies['kiokuko-dsh'] = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).version
  boot.writeProfileManifest(profile, profileManifest)

  const checkPath = join(project, 'check.mjs')
  await writeFile(checkPath, "console.log('orbitlamp verified')\n")
  const mockPath = join(base, 'mock.mjs')
  const mock = await transform(await readFile(join(root, 'tests/dsh/helpers/native-mock.ts'), 'utf8'), { loader: 'ts', format: 'esm' })
  await writeFile(mockPath, mock.code)
  const url = (...parts) => JSON.stringify(pathToFileURL(join(...parts)).href)
  const fixture = join(base, 'fixture.mjs')
  await writeFile(fixture, `
import {execFileSync} from 'node:child_process';
import * as llm from ${url(packageRoot,'@deepseek-ai/dsh-llm/lib/index.js')};
import {nativeMock} from ${url(mockPath)};
import {openConnection} from ${url(installed,'dist/db/connection.js')};
import {initializeDatabase} from ${url(installed,'dist/dsh/database.js')};
import {resolveProjectWorkspace} from ${url(installed,'dist/memory/workspaces.js')};
import {recordEntryInTransaction} from ${url(installed,'dist/memory/entries.js')};
import {createApprovedReplayMemoryStore} from ${url(installed,'dist/memory/replay-store.js')};
import {prepareAgentTask} from ${url(installed,'dist/dsh/task-intake.js')};
import {observeProcessResult} from ${url(installed,'dist/dsh/execution-result.js')};
import {assessTaskCompletion,bindTaskCriterion,beginTaskCompletionExecution,finishTaskCompletionExecution,saveTaskCompletionReceipt} from ${url(installed,'dist/dsh/task-completion.js')};
import {LedgerStore} from ${url(installed,'dist/ledger/store.js')};
export const name='memory-sidebar-fixture',inject=['workspaceRegistry','llm'];
export async function apply(ctx){
  const project=${JSON.stringify(project)}, databasePath=${JSON.stringify(join(env.KIOKUKO_DATA_DIR,'kiokuko-dsh.sqlite3'))};
  await ctx.workspaceRegistry.create(project,'Memory verification');
  const mock=nativeMock(llm);
  ctx.llm.registerAdapter(['memory-fixture'],new mock.MockAdapter([
    () => mock.textResponse('Fixture answer.'),
    () => mock.textResponse('Second fixture answer.'),
  ]));
  await initializeDatabase({databasePath});
  const db=openConnection(databasePath);
  try {
    const {workspace}=await resolveProjectWorkspace(db,project,{allowDirectory:true});
    const proposal={schemaVersion:1,proposalId:'orbitlamp-experience',revision:1,
      source:{workspace,taskId:'source-task',sessionId:'source-session',traces:[]},
      request:{text:'Original orbitlamp user message.',evidenceRefs:['native:source-session:3']},
      attempts:[{attemptId:'past-attempt',tool:'run',callRef:'native:source-session:4',resultRef:'native:source-session:5',outcome:'succeeded',execution:'completed',outputExcerpt:'Original orbitlamp tool result.',payloadHashes:[],limitations:[]}],
      findings:[],languages:[],tags:[],keywords:['orbitlamp']};
    let entry;
    createApprovedReplayMemoryStore(db,workspace,(p,key)=>entry=recordEntryInTransaction(db,{workspace,kind:'reference',title:'Orbitlamp memory',summary:'A previously approved experience.',body:JSON.stringify(p),tags:['orbitlamp'],provenance:{type:'user_approved_replay',reference:key}})).save(proposal,'c'.repeat(64));

    // Seed one historical task with a real verifier result. The native
    // task-completion integration test owns the live attribution tool contract.
    const command='node check.mjs';
    const task=await prepareAgentTask(db,{requestId:'separate-orbitlamp-verification',cwd:project,
      task:'Check orbitlamp output.\\n完了条件: node check.mjs',dshSessionId:'prior-check-session',completionMode:'enforce',
      profileHints:{taskType:'research',target:'check.mjs',expected:'Verify the output',constraints:null},capabilities:[],skillDiscoveryMode:'off'});
    const runId=task.run.runId, criterionId=assessTaskCompletion(db,runId).criteria[0].criterionId;
    bindTaskCriterion(db,{runId,callId:'binding',criterionId,approved:true,method:{
      kind:'native_command',command,cwd:'.',sourcePaths:['check.mjs'],assertion:'output_matches',
      expectedOutput:'orbitlamp verified',appliedMemories:[{entryId:entry.id,revision:entry.revision}]}});
    if(!beginTaskCompletionExecution(db,{runId,callId:'orbitlamp-check',command,repositoryRoot:project})) throw new Error('Historical verifier did not bind');
    const output=execFileSync(process.execPath,['check.mjs'],{cwd:project,encoding:'utf8'});
    finishTaskCompletionExecution(db,{runId,callId:'orbitlamp-check',result:observeProcessResult({isError:false,
      value:{exitCode:0,signal:null,timedOut:false,aborted:false,processStarted:true,processStopped:true,outputComplete:true},
      content:[{type:'text',text:output}]})});
    if(!saveTaskCompletionReceipt(db,runId).verified) throw new Error('Historical verifier did not pass');
    new LedgerStore(db).updateRunStatus(runId,'completed');
  }finally{db.close()}
}
`)
  await writeFile(join(profile, 'cordis.patch.yml'), `- id: session-title-llm
  disabled: true
- id: agent-default-model
  config: {provider: memory-fixture, model: mock}
- id: kiokuko-dsh
  config:
    enabled: true
    toolExposure: {mode: full}
    agenticReplay: {enabled: false}
    typedDecisions: {mode: off}
    answerReview: {mode: off}
    lisp: {enabled: false}
- insert:
    - id: memory-sidebar-fixture
      name: ${JSON.stringify(fixture)}
      inject: [workspaceRegistry, llm]
`)
  host = spawn(environment.DSH_BIN, ['--profile', 'web', '--no-open', '--port', webTestPort()],
    { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [host.stdout, host.stderr]) stream.on('data', chunk => { logs += chunk })
  const web = await waitForUrl()
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  })
  page = await browser.newPage({ locale: 'en-US', viewport: { width: 1280, height: 844 } })
  await installFixtureQuestionAnswers(page)
  const credentials = page.getByRole('dialog', { name: 'Add an API key to get started', exact: true })
  await page.addLocatorHandler(credentials, () => credentials.getByRole('button', { name: 'Configure later', exact: true }).click())
  await page.goto(web)
  const welcome = page.getByRole('button', { name: 'Continue', exact: true })
  await welcome.or(credentials).first().waitFor()
  if (await welcome.isVisible()) await welcome.click()
  const chooseWorkspace = page.getByRole('button', { name: 'Choose workspace', exact: true }).first()
  if (await chooseWorkspace.isVisible()) {
    await chooseWorkspace.click()
    await page.getByRole('menuitem', { name: /Memory verification/ }).click()
  }
  const composer = page.locator('[data-conversation-content]:visible [data-composer-input="true"][contenteditable="true"][data-phase="plain"]:visible').first()
  const send = async text => {
    await composer.fill(text)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
  }
  await send('What is orbitlamp?')
  await answerTaskStartupForTest(page)
  await page.getByText('Fixture answer.', { exact: true }).first().waitFor()
  const toggle = page.getByRole('button', { name: 'Open right sidebar', exact: true })
  if (await toggle.isVisible()) await toggle.click()
  await page.getByRole('button', { name: /^Memory/ }).first().click()
  const sidebar = page.getByRole('region', { name: 'Memory', exact: true })
  const item = sidebar.getByText('Orbitlamp memory', { exact: true })
  await item.focus()
  await page.keyboard.press('Enter')
  for (const expected of ['Revision 1', 'Original orbitlamp user message.', 'Original orbitlamp tool result.',
    'Request terms matched an approved past experience in this project', 'Reuse check passed', 'Verification reference orbitlamp-check']) {
    await sidebar.getByText(expected, { exact: true }).waitFor()
  }
  await writeFile(checkPath, "console.log('changed after the check')\n")
  await sidebar.getByText('Needs rechecking', { exact: true }).waitFor()
  assert.equal(await sidebar.getByText('Reuse check passed', { exact: true }).count(), 0)
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await sidebar.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'sidebar must fit its narrow frame')
  await page.setViewportSize({ width: 1280, height: 844 })
  await send('What is a kumquat?')
  await sidebar.getByText('No available memories for this request.', { exact: true }).waitFor()
  assert.equal(await item.count(), 0)
  console.log(JSON.stringify({ runtime: manifest.version, packedWeb: true, nativeSidebar: true, reuseFreshness: true }))
} catch (error) {
  console.error(logs.slice(-4800).replace(/token=[^\s]+/g, 'token=[redacted]'))
  if (page) console.error((await page.locator('body').innerText().catch(() => '')).slice(-3000))
  throw error
} finally {
  await browser?.close()
  if (host && host.exitCode === null && host.signalCode === null) {
    host.kill('SIGTERM')
    const exited = new Promise(resolve => host.once('exit', resolve))
    const timeout = setTimeout(() => host.kill('SIGKILL'), 5000)
    await exited
    clearTimeout(timeout)
  }
  await rm(base, { recursive: true, force: true })
}
completeVerification({ packedWeb: true, nativeSidebar: true, reuseFreshness: true })
