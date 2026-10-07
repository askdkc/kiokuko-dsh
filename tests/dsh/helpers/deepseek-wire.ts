/** Valid provider SSE for the two pinned DSH serializers; no network dispatch. */
export function deepSeekFixtureResponse(url: string, model: string, output: { text?: string; tool?: { id: string; name: string; arguments: object } }): Response {
  const messages = new URL(url).pathname.endsWith('/messages')
  let events: object[]
  if (messages) {
    const block = output.tool ? { type: 'tool_use', id: output.tool.id, name: output.tool.name, input: {} } : { type: 'text', text: '' }
    const delta = output.tool ? { type: 'input_json_delta', partial_json: JSON.stringify(output.tool.arguments) } : { type: 'text_delta', text: output.text }
    events = [
      { type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 20, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: block },
      { type: 'content_block_delta', index: 0, delta },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: output.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } },
      { type: 'message_stop' },
    ]
  } else {
    if (!new URL(url).pathname.endsWith('/chat/completions')) throw new Error('Unsupported fixture provider endpoint')
    const delta = output.tool ? { tool_calls: [{ index: 0, id: output.tool.id, type: 'function', function: { name: output.tool.name, arguments: JSON.stringify(output.tool.arguments) } }] } : { content: output.text }
    events = [{ id: 'fixture', model, choices: [{ index: 0, delta, finish_reason: null }] },
      { id: 'fixture', model, choices: [{ index: 0, delta: {}, finish_reason: output.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } }]
  }
  const stream = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (messages ? '' : 'data: [DONE]\n\n')
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}

export function wireText(body: any): string {
  const text = (content: any): string[] => typeof content === 'string' ? [content]
    : (content ?? []).flatMap((block: any) => block.type === 'text' ? [block.text] : block.type === 'tool_result' ? text(block.content) : [])
  return [...text(body.system), ...(body.messages ?? []).flatMap((message: any) => text(message.content))].join('\n')
}

export function wireToolResults(body: any): Map<string, any> {
  return new Map((body.messages ?? []).flatMap((message: any) => {
    if (message.role === 'tool') return [[message.tool_call_id, JSON.parse(message.content)]]
    return (Array.isArray(message.content) ? message.content : []).filter((block: any) => block.type === 'tool_result')
      .map((block: any) => [block.tool_use_id, JSON.parse(typeof block.content === 'string' ? block.content : block.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join(''))])
  }))
}
