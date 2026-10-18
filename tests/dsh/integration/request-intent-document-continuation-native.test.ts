import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeSkillFixture } from '../helpers/skill-native.js'
import { nativeToolResults } from '../helpers/native-mock.js'
import { interpretedPreparation, fixtureDefinition, toolValue } from '../helpers/coding-script.js'
import { isolateSkillHome } from '../helpers/skill-home.js'

isolateSkillHome()
const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const packageRoot = process.env.KIOKUKO_SKILL_PACKAGE_ROOT
const extra = { lisp: { enabled: false }, typedDecisions: { mode: 'off' }, answerReview: { mode: 'off' },
  memoryReview: { mode: 'off' }, memoryEvolution: { mode: 'off' }, memoryIndexReasoning: { mode: 'off' },
  deepPlanning: { enabled: false }, modelAutoMode: { mode: 'off' } }
const initial = 'fn main() {}\n'
const implementation = 'fn main(){println!("native");}\n'
const expected = 'fn main(){println!("owned");}\n'
function currentContext(request: any) {
  const section = request.messages.flatMap((message: any) => message.source?.sections ?? [])
    .filter((value: any) => value.name === 'on-demand-intake').at(-1)?.text
  assert.ok(section, 'the real host must provide current source references')
  return JSON.parse(section.split('Current request references and same-session work (host-bound, advisory only):\n')[1].split('\n')[0])
}
function result(request: any, id: string) {
  const value = nativeToolResults(request.messages).find(value => value.toolCallId === id)
  assert.ok(value, id)
  return value
}
for (const explicit of [false, true]) for (const restart of [false, true]) test(
  `README → discussion → implementation keeps current authority (${explicit ? 'adapter' : 'public'}, restart=${restart})`,
  { timeout: 120000 }, async () => {
    const f = await nativeSkillFixture({ packages, ...(packageRoot ? { packageRoot } : {}), explicit, mode: 'compiled', extra })
    let nativeWrites = 0, oldRefs: string[] = [], currentRefs: string[] = [], releaseDeny = () => {}
    const releaseRead = f.ctx.tools.register({ name: 'read', description: 'Read the isolated source',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      output: { schema: {}, render: (_: any, value: string) => [{ type: 'text', text: value }] },
      execute: (args: any) => readFile(join(f.dir, args.path), 'utf8') })
    const releaseEdit = f.ctx.tools.register({ name: 'edit', description: 'Edit the isolated source through native dispatch',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      output: { schema: {}, render: (_: any, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args: any) => { nativeWrites++; await writeFile(join(f.dir, args.path), args.content); return { saved: true } } })
    try {
      await mkdir(join(f.dir, 'src')); await writeFile(join(f.dir, 'src/main.rs'), initial)
      f.responses.push((request: any) => { oldRefs = currentContext(request).references; return interpretedPreparation(f.mock, 'readme-prepare', 'new', 'change', 'writing')(request) },
        f.mock.toolCallResponse('readme-write', 'kioku_write', { path: 'README.md', content: '# CLI\nDescribe this helper.\n' }),
        (request: any) => { assert.equal(result(request, 'readme-write').isError, false); return f.mock.textResponse('README completed. I can implement the described Rust CLI next.') })
      await f.turn('Create README.md describing this CLI. 通常実行で。')
      f.responses.push(f.mock.textResponse('I can implement the described CLI behavior in src/main.rs and verify it.'))
      await f.turn('Explain whether the Rust CLI can implement the described behavior. Do not change files yet.')
      if (restart) { if (explicit) await f.reloadHost('compiled'); else await f.reload('compiled') }
      const preparation = () => ({ requestIntent: { relation: 'same_scope_continuation', action: 'change', changeScope: 'implementation', evidenceRefs: currentRefs } })
      f.responses.push((request: any) => {
        const context = currentContext(request)
        currentRefs = context.references.filter((reference: string) => !reference.startsWith('proposal:'))
        assert.notDeepEqual(currentRefs, oldRefs)
        assert.ok(context.references.some((reference: string) => reference.startsWith('proposal:')), 'same-session proposal exists but is not invented as selected evidence')
        return f.mock.toolCallResponse('inspect-source', 'read', { path: 'src/main.rs' })
      }, (request: any) => {
        assert.equal(result(request, 'inspect-source').isError, false)
        return f.mock.toolCallResponse('premature-edit', 'edit', { path: 'src/main.rs', content: implementation })
      }, async (request: any) => {
        assert.equal(result(request, 'premature-edit').isError, true); assert.equal(nativeWrites, 0)
        assert.equal(await readFile(join(f.dir, 'src/main.rs'), 'utf8'), initial)
        return f.mock.toolCallResponse('old-source-prepare', 'prepare_requested_work', { requestIntent: { ...preparation().requestIntent, evidenceRefs: oldRefs } })
      }, (request: any) => {
        assert.equal(result(request, 'old-source-prepare').isError, true)
        return f.mock.toolCallResponse('implementation-prepare', 'prepare_requested_work', preparation())
      }, (request: any) => {
        const prepared = toolValue(request, 'implementation-prepare')
        assert.equal(prepared.taskType, 'build'); assert.equal(prepared.permissions, 'unchanged_native_policy')
        assert.deepEqual(prepared.requestIntent.evidence.proposalRefs, [])
        return f.mock.toolCallResponse('same-request-retry', 'prepare_requested_work', preparation())
      }, (request: any) => { assert.equal(result(request, 'same-request-retry').isError, false); return f.mock.toolCallResponse('goal-status', 'coding_workflow', { action: 'status' }) },
      (request: any) => f.mock.toolCallResponse('goal-propose', 'coding_workflow_apply', { action: 'propose', expectedRevision: toolValue(request, 'goal-status').revision, definition: fixtureDefinition('src/main.rs') }),
      (request: any) => {
        assert.equal(result(request, 'goal-propose').isError, false)
        releaseDeny = f.ctx.tools.guard((execution: any) => execution.name === 'edit' ? 'NATIVE_TEST_DENIED' : undefined)
        return f.mock.toolCallResponse('native-denied', 'edit', { path: 'src/main.rs', content: implementation })
      }, (request: any) => {
        assert.equal(result(request, 'native-denied').isError, true); assert.equal(nativeWrites, 0)
        releaseDeny(); releaseDeny = () => {}
        return f.mock.toolCallResponse('native-edit', 'edit', { path: 'src/main.rs', content: implementation })
      }, (request: any) => {
        assert.equal(result(request, 'native-edit').isError, false)
        return f.mock.toolCallResponse('owned-edit', 'kioku_edit', { path: 'src/main.rs', oldText: 'native', newText: 'owned' })
      }, (request: any) => {
        assert.equal(result(request, 'owned-edit').isError, false, JSON.stringify(result(request, 'owned-edit')))
        const code = 'require("node:assert/strict").equal(require("node:fs").readFileSync("src/main.rs","utf8"),' + JSON.stringify(expected) + ')'
        return f.mock.toolCallResponse('owned-command', 'kioku_exec', { command: `${process.execPath} -e '${code}'` })
      }, (request: any) => {
        assert.equal(result(request, 'owned-command').isError, false, JSON.stringify(result(request, 'owned-command')))
        return f.mock.textResponse('Native Edit, owned edit and verification command succeeded for the current request.')
      })
      await f.turn('Then implement the described Rust CLI behavior in src/main.rs. 通常実行で。')
      assert.equal(nativeWrites, 1); assert.equal(await readFile(join(f.dir, 'src/main.rs'), 'utf8'), expected)
      const starts = f.agent.session.snapshotEvents().filter((event: any) => event.type === 'turn/start').map((event: any) => event.data.turn)
      assert.deepEqual(starts, [1, 2, 3], 'README and implementation belong to separate real native turns')
    } finally { releaseDeny(); releaseRead(); releaseEdit(); await f.close() }
  })
