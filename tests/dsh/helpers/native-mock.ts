import assert from 'node:assert/strict'

/** DSH v3 nests tool results; v4 keeps the same identity on tool-role messages. */
export function nativeToolResults(messages: readonly any[]): any[] {
  return messages.flatMap(message => message.role === 'tool' ? [message]
    : (message.content ?? []).filter((block: any) => block.type === 'tool-result'))
}

/** Scripted model, running through the real published DSH stream and tool APIs. */
export function nativeMock(llm: any) {
  function textResponse(text: string): any[] {
    return [{ type: 'block-start', index: 0, blockType: 'text' },
      ...Array.from(text, char => ({ type: 'text-delta', index: 0, text: char })),
      { type: 'block-end', index: 0, block: { type: 'text', text } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
      { type: 'finish', reason: { kind: 'stop' } }]
  }
  function toolCallResponse(id: string, name: string, args: object): any[] {
    const argumentsJson = JSON.stringify(args)
    return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'tool-calls' } }]
  }
  function prepareWork(script: any[], taskType: string, id: string): any[] {
    const [first, ...rest] = script
    assert.ok(first, 'prepared work must have a consumer')
    return [(request: any) => {
      assert.ok(request.tools.some((tool: any) => tool.name === 'prepare_requested_work'), 'native preparation must be discoverable')
      return toolCallResponse(id, 'prepare_requested_work', { taskType })
    }, (request: any) => {
      const result = request.messages.flatMap((message: any) => message.role === 'tool' && message.toolCallId === id ? [message]
        : (message.content ?? []).filter((block: any) => block.type === 'tool-result' && block.toolCallId === id)).at(-1)
      assert.ok(result && !result.isError, 'native preparation must succeed before consuming the workflow')
      const value = JSON.parse(result.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join(''))
      assert.equal(value.prepared, true)
      assert.equal(value.permissions, 'unchanged_native_policy')
      assert.equal(typeof value.originalTask, 'string')
      assert.ok(value.originalTask.length)
      return typeof first === 'function' ? first(request) : first
    }, ...rest]
  }
  class MockAdapter extends llm.LlmAdapter {
    readonly requests: any[] = []
    constructor(private readonly script: any[], private readonly modelIds: readonly string[] = ['mock']) { super() }
    prepareNext(taskType: string, id: string) { this.script.splice(0, 1, ...prepareWork([this.script[0]], taskType, id)) }
    async listModels(provider: string) { return this.modelIds.map(id => ({ provider, id, name: id })) }
    async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
    async *stream(options: any) {
      this.requests.push(options)
      const entry = this.script.shift()
      if (entry === undefined) throw new Error('Native mock script exhausted')
      for await (const chunk of await (typeof entry === 'function' ? entry(options) : entry)) {
        options.signal?.throwIfAborted()
        yield chunk
      }
    }
  }
  return { textResponse, toolCallResponse, prepareWork, MockAdapter }
}
