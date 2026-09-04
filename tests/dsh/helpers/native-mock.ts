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
  class MockAdapter extends llm.LlmAdapter {
    readonly requests: any[] = []
    constructor(private readonly script: any[]) { super() }
    async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
    async *stream(options: any) {
      this.requests.push(options)
      const entry = this.script.shift()
      if (entry === undefined) throw new Error('Native mock script exhausted')
      for (const chunk of typeof entry === 'function' ? entry(options) : entry) {
        options.signal?.throwIfAborted()
        yield chunk
      }
    }
  }
  return { textResponse, toolCallResponse, MockAdapter }
}
