import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { mountDshModelTools } from '../../../src/dsh/tools.js'

const dshSourceRoot = process.env.KIOKUKO_DSH_SOURCE_ROOT
const dshPackageRoot = process.env.KIOKUKO_DSH_PACKAGE_ROOT

function dshModule(sourcePath: string, packageName: string): string {
  if (dshSourceRoot !== undefined) return pathToFileURL(join(dshSourceRoot, sourcePath)).href
  if (dshPackageRoot !== undefined) return pathToFileURL(join(dshPackageRoot, '@deepseek-ai', packageName, 'lib/index.js')).href
  throw new Error('a DeepSeek Harness source or package root is required')
}

test('a terminal Enno tool result stays in the native turn until a visible assistant report is emitted', {
  skip: dshSourceRoot === undefined && dshPackageRoot === undefined
    ? 'requires a DeepSeek Harness source checkout or installed package root'
    : false,
}, async () => {
  const [cordis, llm, session, projection, systemPrompt, tools, agentRegistry, agentLoop, skills] = await Promise.all([
    import(dshModule('vendor/cordis/lib/index.js', 'cordis')),
    import(dshModule('packages/llm/llm/lib/index.js', 'dsh-llm')),
    import(dshModule('packages/core/session/lib/index.js', 'dsh-session')),
    import(dshModule('packages/session/session-projection/lib/index.js', 'dsh-session-projection')),
    import(dshModule('packages/core/system-prompt/lib/index.js', 'dsh-system-prompt')),
    import(dshModule('packages/core/tools/lib/index.js', 'dsh-tools')),
    import(dshModule('packages/core/agent/lib/index.js', 'dsh-agent')),
    import(dshModule('packages/core/agent-loop/lib/index.js', 'dsh-agent-loop')),
    import(dshModule('packages/skill/skill/lib/index.js', 'dsh-skill')),
  ])

  const textResponse = (text: string): any[] => [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const toolCallResponse = (rawCallId: string, name: string, args: object): any[] => {
    const id = llm.ToolCallId(rawCallId)
    const argumentsJson = JSON.stringify(args)
    return [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
  }
  class TerminalAdapter extends llm.LlmAdapter {
    readonly requests: unknown[] = []
    readonly #script = [
      toolCallResponse('terminal-meditation', 'enno_meditation_submit', {
        meditation: { summary: 'No deletion candidates.', inspectedPaths: ['src'], deletionCandidates: [] },
      }),
      textResponse('Completed: the requested change and verification succeeded.'),
    ]

    resolveModel(provider: string, model: string): Promise<unknown> {
      return Promise.resolve({ provider, id: model, name: model })
    }

    async * stream(options: unknown): AsyncIterable<unknown> {
      this.requests.push(options)
      const chunks = this.#script.shift()
      if (chunks === undefined) throw new Error('terminal report adapter script exhausted')
      for (const chunk of chunks) yield chunk
    }
  }

  const ctx = new cordis.Context()
  const fibers: any[] = []
  const use = async (plugin: unknown, config?: unknown): Promise<void> => {
    const fiber = config === undefined ? ctx.plugin(plugin) : ctx.plugin(plugin, config)
    fibers.push(fiber)
    await fiber
  }
  let disposeTools: (() => void) | undefined
  try {
    await use(llm.default)
    await use(session.default)
    await use(projection.default)
    await use(systemPrompt.default, { persona: '' })
    await use(tools.default)
    await use(agentRegistry.default)
    await use(skills.default)
    await use(agentLoop.default, { agents: [] })

    const adapter = new TerminalAdapter()
    ctx.llm.registerAdapter(['terminal-report'], adapter)
    let executions = 0
    disposeTools = mountDshModelTools({ tools: ctx.tools }, {
      bind: (execution) => {
        assert.equal(execution.agent?.dshSessionId, 'terminal-report-session')
        return {
          runId: 'terminal-run', dshSessionId: 'terminal-report-session', workspace: 'terminal-workspace',
          orchestrationId: 'terminal-orchestration', revision: 2, routeEpoch: 0,
        }
      },
      execute: async (operation) => {
        assert.equal(operation, 'enno_meditation_submit')
        executions += 1
        return {
          kind: 'applied',
          value: { ennoOduno: { nextAction: 'complete' } },
          handoff: { schemaVersion: 1, runId: 'terminal-run', phase: 'meditation', revision: 2, nextAction: 'complete' },
        }
      },
    })

    const agent = await ctx.agentLoop.create(
      session.SessionId('terminal-report-session'),
      { provider: 'terminal-report', model: 'mock' },
      { cwd: process.cwd() },
    )
    const idle = new Promise<void>((resolve) => {
      const dispose = ctx.on('agent/status', (payload: { agent: unknown; status: string }) => {
        if (payload.agent === agent && payload.status === 'idle') {
          dispose()
          resolve()
        }
      })
    })
    agent.followup(llm.createUserMessage({
      content: [{ type: 'text', text: 'Complete the task and report the result.' }],
      source: { kind: 'user' },
    }))
    let idleTimeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        idle,
        new Promise<never>((_resolve, reject) => {
          idleTimeout = setTimeout(() => reject(new Error('terminal report loop did not become idle')), 10_000)
        }),
      ])
    } finally {
      clearTimeout(idleTimeout)
    }

    const events = agent.session.snapshotEvents()
    const toolResultIndex = events.findIndex((event: any) => (
      event.type === 'tool/result'
      && event.data.message.content[0]?.toolCallId === 'terminal-meditation'
    ))
    const finalMessageIndex = events.findIndex((event: any) => (
      event.type === 'assistant/message'
      && event.data.message.content.some((block: any) => block.type === 'text'
        && block.text === 'Completed: the requested change and verification succeeded.')
    ))
    const turnEndIndex = events.findIndex((event: any) => event.type === 'turn/end')
    assert.ok(toolResultIndex >= 0)
    assert.ok(finalMessageIndex > toolResultIndex, 'the visible assistant report must follow the terminal tool result')
    assert.ok(turnEndIndex > finalMessageIndex, 'the native turn must end only after the visible assistant report')
    const renderedResult = events[toolResultIndex].data.message.content[0].content
    assert.match(renderedResult[1]?.text ?? '', /visible final assistant response/u)
    assert.equal(executions, 1)
    assert.equal(adapter.requests.length, 2)
  } finally {
    disposeTools?.()
    for (const fiber of fibers.reverse()) await fiber.dispose()
  }
})
