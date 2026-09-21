import { TypedDecisionsConfig } from '../../../src/dsh/decisions/config.js'
export const layaModel = 'aac6fef/laya-multilingual-coreml-ane'
export const layaFingerprint = `sha256:${'a'.repeat(64)}`
export const layaRuntime = { model: layaModel, runtimeFingerprint: layaFingerprint, limits: { maxQuestions: 1, maxChoices: 32, maxBytes: 262144, maxPromptTokens: 96 } }
export function layaConfig(socketPath = '/tmp/kiokuko-laya-fixture.sock') {
  return TypedDecisionsConfig.parse({ provider: 'laya-coreml', 'laya-coreml': { model: layaModel, runtimeFingerprint: layaFingerprint, socketPath } })
}
export function layaReply(request: any, choose: (id: string, choices: string[]) => string = (_id, choices) => choices[0]!): any {
  if (request.op === 'health') return { version: 1, ok: true, status: 'ready', operations: ['health', 'predict', 'preflight', 'predict_strict'], runtime: layaRuntime }
  if (request.op === 'preflight') return { version: 1, ok: true, runtime: layaRuntime, input_tokens: 40 }
  return { version: 1, ok: true, runtime: layaRuntime, server: { predict_ms: 5 }, result: { model: 'laya-rl-agent', usage: { input_tokens: 40, output_tokens: 0 },
    answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]: [string, any]) => {
      const keys = Object.keys(q.criteria), choice = choose(id, keys)
      return [id, { type: 'choice', choice, probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? 1 : 0])), confidence: 0.1, action: { act_probability: 0 } }]
    })) } }
}

// A real framed socket fixture exercises the Node transport without a model or Python.
export async function serveLaya(t: import('node:test').TestContext, reply: (request: any, raw: string) => unknown = request => layaReply(request)) {
  const { createServer } = await import('node:net'), { mkdtemp, rm } = await import('node:fs/promises')
  const dir = await mkdtemp('/tmp/klaya-'), path = `${dir}/w.sock`, sockets = new Set<import('node:net').Socket>()
  let calls = 0
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
    let input = Buffer.alloc(0), done = false
    socket.on('data', chunk => {
      if (done) return
      input = Buffer.concat([input, chunk])
      if (input.length < 4 || input.length < input.readUInt32BE() + 4) return
      done = true; calls++
      const raw = input.subarray(4).toString('utf8'), response = Buffer.from(JSON.stringify(reply(JSON.parse(raw), raw))), header = Buffer.alloc(4)
      header.writeUInt32BE(response.length); socket.write(Buffer.concat([header, response]))
    })
  })
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }) })
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(path, resolve))
  return { path, calls: () => calls }
}
