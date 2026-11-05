import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agenticReplayFixture, request, response, chunks, collect } from '../helpers/agenticreplay-fixture.js'

/** Directory facts for the recorded store: names plus the manifest identity of real runs. */
async function runDirectories(root: string): Promise<{ names: string[]; manifests: string[] }> {
  const runs = join(root, '.agenticreplay', 'runs')
  const entries = await readdir(runs, { withFileTypes: true })
  const names: string[] = []
  const manifests: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    names.push(entry.name)
    try { manifests.push(JSON.parse(await readFile(join(runs, entry.name, 'manifest.json'), 'utf8')).run_id) }
    catch { /* A directory without a manifest is an ID claim, not a recording. */ }
  }
  return { names, manifests }
}

test('a recording leaves one run directory and removes its ID claim', async () => {
  const f = await agenticReplayFixture()
  try {
    await collect(f.recorder.stream(f.binding, request, () => chunks(response('hello'))))
    await f.recorder.closeSessionRecording(f.binding.sessionId, 'manual')
    const row = (await f.reader.list(f.binding))[0]!
    const { names, manifests } = await runDirectories(f.root)
    assert.deepEqual(manifests, [row.agenticreplay_run_id], 'each recording must resolve to exactly one directory')
    assert.equal(
      names.includes(row.agenticreplay_run_id),
      false,
      'a bare run_<id> directory is listed by the core reader as a second empty run',
    )
    assert.equal(names.filter(name => name.startsWith('.claim-')).length, 0, 'the exclusive claim is removed after create()')
  } finally { await f.dispose() }
})

test('a legacy empty run_<id> reservation is removed before the next recording', async () => {
  const f = await agenticReplayFixture()
  try {
    const legacy = join(f.root, '.agenticreplay', 'runs', 'run_0123456789abcdef01234567')
    await mkdir(legacy, { recursive: true, mode: 0o700 })
    await collect(f.recorder.stream(f.binding, request, () => chunks(response('hello'))))
    await f.recorder.closeSessionRecording(f.binding.sessionId, 'manual')
    const { names } = await runDirectories(f.root)
    assert.equal(names.includes('run_0123456789abcdef01234567'), false)
  } finally { await f.dispose() }
})
