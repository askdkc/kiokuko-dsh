import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { attachmentInput, type LispAttachmentStore } from '../../../../src/dsh/lisp/attachment-input.js'
import { FILE_BYTES } from '../../../../src/dsh/lisp/contracts.js'

const bytes = Buffer.from([0x50, 0x4b, 0, 255, 1, 2])
const ref = { attachmentId: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, name: 'upload.zip', bytes: bytes.length }
const path = '/host/attachments/upload.zip'
const event = { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'file', attachment: ref }] } }
const session = { snapshotEvents: () => [event] }

test('attachment input uses the session reference and verifies binary bytes without changing source metadata', async () => {
  let reads = 0
  const store: LispAttachmentStore = { fileHostPath: () => path, async *readFileStream(actual) {
    assert.deepEqual(actual, ref); reads++
    yield bytes.subarray(0, 2); yield bytes.subarray(2)
  } }
  const input = attachmentInput(session, store, path)
  assert.equal(reads, 0, 'authorization and size checks precede byte reads')
  assert.equal(input.size, bytes.length)
  const result = await input.read()
  assert.deepEqual(result, bytes); result[0] = 0
  assert.equal(bytes[0], 0x50)
  assert.deepEqual(event.data.content[0]!.attachment, ref)
  assert.equal(reads, 1)
})

test('paths alone, plugin messages, tool results and other-session attachments grant no authority', () => {
  let reads = 0
  const store: LispAttachmentStore = { fileHostPath: () => path, async *readFileStream() { reads++; yield bytes } }
  for (const events of [[], [{ ...event, type: 'tool/result' }],
    [{ ...event, data: { ...event.data, source: { kind: 'plugin' } } }],
    [{ ...event, data: { ...event.data, content: [{ type: 'text', text: JSON.stringify(event) }] } }]]) {
    assert.throws(() => attachmentInput({ snapshotEvents: () => events }, store, path), { code: 'ATTACHMENT_NOT_IN_SESSION' })
  }
  for (const candidate of ['/host/private.txt', '/host/attachments/../attachments/upload.zip', `${path}-other`]) {
    assert.throws(() => attachmentInput(session, store, candidate), { code: 'ATTACHMENT_NOT_IN_SESSION' })
  }
  assert.equal(reads, 0)
})

test('unsupported host, oversized files, altered bytes, broken streams and cancellation fail closed', async () => {
  const store: LispAttachmentStore = { fileHostPath: () => path, async *readFileStream() { yield bytes } }
  assert.throws(() => attachmentInput(session, undefined, path), { code: 'ATTACHMENT_UNAVAILABLE' })
  assert.throws(() => attachmentInput({}, store, path), { code: 'ATTACHMENT_UNAVAILABLE' })
  const large = { snapshotEvents: () => [{ ...event, data: { ...event.data, content: [{ type: 'file', attachment: { ...ref, bytes: FILE_BYTES + 1 } }] } }] }
  assert.throws(() => attachmentInput(large, store, path), { code: 'FILE_LIMIT' })
  for (const changed of [Buffer.alloc(bytes.length), bytes.subarray(1), Buffer.concat([bytes, bytes])]) {
    let closed = false
    const changedStore = { ...store, async *readFileStream() { try { yield changed } finally { closed = true } } }
    await assert.rejects(attachmentInput(session, changedStore, path).read(), { code: 'ATTACHMENT_CHANGED' })
    assert.equal(closed, true)
  }
  await assert.rejects(attachmentInput(session, { ...store, async *readFileStream() { yield bytes; throw new Error('storage failed') } }, path).read(), /storage failed/)
  const abort = new AbortController()
  const interrupted = attachmentInput(session, { ...store, async *readFileStream() { yield bytes.subarray(0, 2); abort.abort(new Error('cancelled')); yield bytes.subarray(2) } }, path, abort.signal)
  await assert.rejects(interrupted.read(), /cancelled/)
})
