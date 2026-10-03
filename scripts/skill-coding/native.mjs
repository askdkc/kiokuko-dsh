import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
export async function nativeSession({ model, prompt, tools, budget, adapterOverride, signal }) {
    const root = resolve('tests/fixtures/dsh-runtime/node_modules/@deepseek-ai');
    const load = name => import(pathToFileURL(join(root, name, 'lib/index.js')).href);
    const [cordis, llm, session, projection, system, registry, toolPlugin, loop, provider] = await Promise.all(['cordis', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-agent', 'dsh-tools', 'dsh-agent-loop', 'dsh-llm-pi-ai'].map(load));
    const ctx = new cordis.Context();
    try {
        for (const plugin of [llm, session, projection, system, registry, toolPlugin])
            await ctx.plugin(plugin.default, plugin === system ? { persona: '' } : undefined);
        await ctx.plugin(loop.default, { agents: [], maxParallelToolCalls: 1 });
        if (adapterOverride)
            ctx.llm.registerAdapter([model.provider], adapterOverride(llm));
        else {
            if (!process.env[model.apiKeyEnv])
                throw new Error('credential_unavailable');
            await ctx.plugin(provider.default, { providers: { [model.provider]: { api: model.api, baseURL: model.baseURL, apiKeyEnv: model.apiKeyEnv, models: [{ id: model.model, contextWindow: model.contextWindow, maxTokens: model.maxOutputTokens }], retryPolicy: { mode: 'normal', maxRetries: 0 } } } });
        }
        // Count actual streams, not model declarations. No automatic retries are mounted.
        const original = ctx.llm.prepareCall.bind(ctx.llm);
        ctx.llm.prepareCall = async (...args) => { budget.request(model); return original(...args); };
        ctx.systemPrompt.section({ name: 'evaluation', order: 0, text: prompt, complete: true });
        for (const tool of tools)
            ctx.tools.register(tool);
        const agent = await ctx.agentLoop.create(session.SessionId(randomUUID()), { provider: model.provider, model: model.model, maxTokens: model.maxOutputTokens }, { cwd: '/work' });
        return {
            async turn(text) {
                const remaining = budget.deadline - Date.now();
                budget.check();
                let timer;
                let onAbort;
                const start = agent.session.snapshotEvents().length;
                try {
                    agent.followup(llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
                    await Promise.race([agent.whenIdle(), new Promise((_, reject) => {onAbort=()=>{agent.cancel({kind:'user'});reject(new Error('interrupted'))}; if(signal?.aborted)onAbort();else signal?.addEventListener('abort',onAbort,{once:true})}), new Promise((_, reject) => { timer = setTimeout(() => { agent.cancel({ kind: 'user' }); reject(new Error('budget_exhausted')); }, remaining); })]);
                    const events = agent.session.snapshotEvents().slice(start);
                    for (const e of events)
                        if (e.data?.usage)
                            budget.usage.push(e.data.usage);
                    if (events.filter(e => e.type === 'turn/end').at(-1)?.data.reason?.kind !== 'completed') throw new Error('provider_or_turn_failure');
                    const messages = events.filter(e => e.type === 'assistant/message').slice(-1);
                    return messages.flatMap(e => e.data.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
                }
                finally {
                    clearTimeout(timer);
                    if(onAbort)signal?.removeEventListener('abort',onAbort);
                }
            },
            async close() { await ctx.fiber.dispose(); }
        };
    }
    catch (error) {
        await ctx.fiber.dispose();
        throw error;
    }
}
