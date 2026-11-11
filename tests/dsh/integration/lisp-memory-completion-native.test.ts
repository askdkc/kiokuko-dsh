import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { openConnection } from '../../../src/db/connection.js'
import { readRepositoryLearning } from '../../../src/memory/repository-learning.js'
import { nativeSkillFixture } from '../helpers/skill-native.js'
import { nativeToolResults } from '../helpers/native-mock.js'
import { isolateSkillHome } from '../helpers/skill-home.js'

isolateSkillHome()
for (const conflict of [false, true]) test(`native Lisp finishes across reload and isolates conflicting memory (binding conflict=${conflict})`, { timeout: 45000 }, async () => {
  const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
  const f = await nativeSkillFixture({
    packages,
    ...(process.env.KIOKUKO_SKILL_PACKAGE_ROOT ? { packageRoot: process.env.KIOKUKO_SKILL_PACKAGE_ROOT } : {}),
    startupChoice: 'decision OFF / Lisp ON',
    extra: {
      lisp: { enabled: true, executionMode: 'development', sbclPath: process.env.KIOKUKO_LISP_SBCL },
      typedDecisions: { mode: 'off' }, answerReview: { mode: 'off' }, memoryReview: { mode: 'off' },
      memoryEvolution: { mode: 'off' }, memoryIndexReasoning: { mode: 'off' },
      modelAutoMode: { mode: 'off' }, deepPlanning: { enabled: false },
    },
  })
  const fibers: any[] = []
  const diagnostics: any[] = []
  const off = f.ctx.on('session/event', (_session: any, event: any) => {
    if (event.type === 'plugin:kiokuko-dsh/repository-learning') diagnostics.push(event.data)
  }, { global: true })
  const original = f.model.stream.bind(f.model)
  let compactCalls = 0
  f.model.stream = async function* (request: any) {
    if (String(request.system).startsWith('Extract compact repository-scoped learning')) {
      compactCalls++
      const input = JSON.parse(request.messages[0].content[0].text)
      assert.equal(request.purpose, 'compaction')
      assert.deepEqual(request.tools, [])
      const result = input.observations.find((value: any) => value.type === 'tool/result')
      yield* f.mock.textResponse(JSON.stringify({
        summary: 'Lisp wrote the JSON artifact and parsed it successfully.', tags: ['json-artifact'], keywords: ['artifact.json', 'JSON.parse'],
        lessons: result ? [{ hypothesis: 'JSON serialization produced a parseable artifact.', applicability: 'When writing artifact.json',
          nextAction: 'Serialize then parse the artifact.', verifyWith: 'Read artifact.json and assert answer equals 42.', evidenceRefs: [result.ref] }] : [],
      }))
      return
    }
    yield* original(request)
  }
  const snapshot = () => {
    const db = openConnection(join(f.dir, 'kiokuko-dsh.sqlite3'))
    try { return readRepositoryLearning(db, f.dir) } finally { db.close() }
  }
  try {
    if (conflict) {
      await writeFile(join(f.dir, '.kiokuko.json'), JSON.stringify({schemaVersion:1, repositoryId:'repo_foreign', workspace:'project:foreign', agentFile:'AGENTS.md', templateVersion:1}))
      await f.reload('compiled')
    }
    // Supply the ordinary DSH foreground process service, including its native
    // permission/Stop path; the minimal fixture deliberately has no Bash tool.
    for (const name of ['dsh-subprocess-local', 'dsh-bash-local', 'dsh-shell-env', 'dsh-tool-bash']) {
      const plugin = await import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)
      fibers.push(await f.ctx.plugin(plugin.default ?? plugin,
        name === 'dsh-bash-local' ? { cwd: f.dir } : name === 'dsh-shell-env' ? { dshHome: f.dir } : {}))
    }
    const script = "const fs=require('node:fs');fs.writeFileSync('artifact.json',JSON.stringify({answer:42}));if(JSON.parse(fs.readFileSync('artifact.json')).answer!==42)process.exit(1);console.log('artifact verified')"
    f.responses.push(
      f.mock.toolCallResponse('write-artifact', 'lisp_eval', { operationId: 'write-artifact',
        code: `(kioku.process:run ${JSON.stringify(process.execPath)} (list "-e" ${JSON.stringify(script)}))` }),
      (request: any) => {
        const result = nativeToolResults(request.messages).find((value: any) => value.toolCallId === 'write-artifact')
        assert.equal(result?.isError, false, JSON.stringify(result))
        assert.match(JSON.stringify(result), /artifact verified/)
        return f.mock.textResponse('artifact.json を作成し、answer が42であることを確認しました。')
      },
    )
    await f.turn('artifact.json を作成して answer に42を入れてください。\n保存後にJSONとして読み直して検証してください。\n外部には公開しないでください。')
    assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'artifact.json'), 'utf8')), { answer: 42 })
    const deadline = Date.now() + 10000
    // Wait for the terminal capture observation, not for an arbitrary quiet interval.
    const captured = () => diagnostics.find(value => value.phase === 'capture')
    while (!captured() && Date.now() < deadline) await delay(20)
    assert.equal(captured()?.status, conflict ? 'unavailable' : 'saved', JSON.stringify(diagnostics))
    assert.equal(snapshot().turnCount, conflict ? 0 : 1)
    if (conflict) assert.deepEqual(snapshot().points, [])
    else assert.ok(snapshot().points.some(point => point.keywords?.includes('artifact.json')))
    assert.equal(f.memoryQuestions.length, 0)
    assert.equal(compactCalls, conflict ? 0 : 1)
    await f.reload('compiled')
    f.responses.push((request: any) => {
      const memory = request.messages.find((message: any) => message.source?.sections?.some((section: any) => section.name === 'memory:repository-learning'))
      if (conflict) assert.equal(memory, undefined, 'conflicting memory must not reach the model after reload')
      else {
        assert.ok(memory, 'committed memory is retrieved through the normal model request')
        assert.match(JSON.stringify(memory), /artifact.json/)
      }
      return f.mock.textResponse('artifact.json は JSON として読み直して確認しました。')
    })
    await f.turn('artifact.json の検証結果を説明してください。変更は不要です。')
    assert.equal(f.memoryQuestions.length, 0)
  } finally { off(); for (const fiber of fibers.reverse()) await fiber.dispose(); await f.close() }
})
