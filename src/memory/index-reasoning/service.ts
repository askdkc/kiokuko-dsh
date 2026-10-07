import type { SqliteDatabase } from '../../db/adapter.js';
import { withImmediateTransaction } from '../../db/transaction.js';
import type { DshLlm } from '../../dsh/session-memory-finalizer.js';
import { configureIndex, reserveIndexJob, reconcileIndexSources, indexSettings as indexSettingsForCommand } from './store.js';
import { IndexModel, type IndexReasoningConfig } from './contracts.js';
import { IndexReasoningWorker } from './worker.js';
export type IndexRuntime = {
    withDatabase<T>(f: (db: SqliteDatabase) => T | PromiseLike<T>): Promise<T>;
};
export class IndexReasoningService {
    readonly worker: IndexReasoningWorker;
    readonly #conversations = new Map<string, Map<string, () => boolean>>();
    #closed = false;
    constructor(readonly runtime: IndexRuntime, readonly config: IndexReasoningConfig, llm?: DshLlm) {
        this.worker = new IndexReasoningWorker({ runtime, config, ...(llm ? { llm } : {}) });
    }
    async start(): Promise<void> {
        await this.runtime.withDatabase(db => {
            for (const row of db.prepare("SELECT workspace FROM memory_index_settings UNION SELECT workspace FROM repositories WHERE workspace<>'global'").all<{
                workspace: string;
            }>())
                configureIndex(db, row.workspace, this.config.mode, this.config);
        });
        this.worker.kick();
    }
    async dispose(): Promise<void> {
        this.#closed = true;
        this.#conversations.clear();
        await this.worker.dispose();
    }
    async whenIdle(): Promise<void> {
        await this.worker.whenIdle();
    }
    async admitIndex(workspace: string, sessionId: string, envelope: unknown): Promise<void> {
        await this.#admit(workspace, sessionId, envelope, db => !!db.prepare('SELECT 1 FROM ledger_runs WHERE workspace=? AND dsh_session_id=?').get(workspace, sessionId));
    }
    /**
     * Trusted native host only. The synchronous callback must verify the live
     * agent/session/workspace; it also gates later commands for this binding.
     * Conversation admission never creates a task or bypasses source checks.
     */
    async admitConversation(workspace: string, sessionId: string, envelope: unknown, assertCurrent: () => boolean): Promise<void> {
        const admitted = await this.#admit(workspace, sessionId, envelope, () => !this.#closed && assertCurrent() === true);
        if (!admitted || this.#closed)
            return;
        const bindings = this.#conversations.get(sessionId) ?? new Map<string, () => boolean>();
        bindings.set(workspace, assertCurrent);
        this.#conversations.set(sessionId, bindings);
    }
    async #admit(workspace: string, sessionId: string, envelope: unknown, authorized: (db: SqliteDatabase) => boolean): Promise<boolean> {
        if (typeof envelope !== 'object' || envelope === null)
            return false;
        const e = envelope as Record<string, unknown>;
        const model = IndexModel.safeParse({ provider: e.provider, model: e.model, contextWindow: e.contextWindow, sessionId, ...(e.reasoningEffort ? { reasoningEffort: e.reasoningEffort } : {}) });
        const admitted = await this.runtime.withDatabase(db => withImmediateTransaction(db, () => {
            if (!authorized(db))
                return false;
            configureIndex(db, workspace, this.config.mode, this.config);
            if (!model.success) {
                db.prepare('UPDATE memory_index_settings SET model_json=NULL WHERE workspace=?').run(workspace);
                return true;
            }
            db.prepare('UPDATE memory_index_settings SET model_json=? WHERE workspace=?').run(JSON.stringify(model.data), workspace);
            reconcileIndexSources(db, workspace);
            reserveIndexJob(db, workspace, model.data);
            return true;
        }));
        this.worker.kick();
        return admitted;
    }
    #conversationWorkspaces(sessionId: string): string[] {
        const bindings = this.#conversations.get(sessionId);
        if (!bindings)
            return [];
        for (const [workspace, assertCurrent] of bindings) {
            try {
                if (assertCurrent() === true)
                    continue;
            } catch { /* A retired host binding must fail closed. */ }
            bindings.delete(workspace);
        }
        if (!bindings.size)
            this.#conversations.delete(sessionId);
        return [...bindings.keys()];
    }
    async indexCommand(sessionId: string, raw: string): Promise<Record<string, unknown>> {
        const result = await this.runtime.withDatabase(db => withImmediateTransaction(db, () => {
            const rows = db.prepare('SELECT DISTINCT workspace FROM ledger_runs WHERE dsh_session_id=? LIMIT 2').all<{
                workspace: string;
            }>(sessionId);
            const workspaces = new Set([...rows.map(row => row.workspace), ...this.#conversationWorkspaces(sessionId)]);
            if (workspaces.size !== 1)
                throw new Error('workspace_unknown');
            const workspace = [...workspaces][0]!, parts = raw.trim().split(/\s+/);
            if (!indexSettingsForCommand(db, workspace))
                configureIndex(db, workspace, this.config.mode, this.config);
            if (parts[0] === 'mode' && parts.length === 2 && ['active', 'observe', 'off'].includes(parts[1]!))
                configureIndex(db, workspace, parts[1]!);
            else if (parts[0] === 'retry' && parts.length === 2) {
                const old = db.prepare("SELECT * FROM memory_index_jobs WHERE id=? AND workspace=? AND state='held'").get<{
                    id: string;
                    input_json: string;
                    input_digest: string;
                    model_json: string;
                    stage: number;
                    drafts_json: string;
                    peers_json: string;
                    peers_digest: string | null;
                    priority: number;
                }>(parts[1]!, workspace);
                if (!old)
                    throw new Error('job_unavailable');
                db.prepare("INSERT OR IGNORE INTO memory_index_jobs(id,workspace,input_json,input_digest,model_json,stage,drafts_json,peers_json,peers_digest,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(`retry:${old.id}`, workspace, old.input_json, old.input_digest, old.model_json, old.stage, old.drafts_json, old.peers_json, old.peers_digest, old.priority, new Date().toISOString(), new Date().toISOString());
            }
            else if (parts[0] === 'backfill' && parts.length === 1)
                reconcileIndexSources(db, workspace);
            else if (!(parts[0] === '' || parts[0] === 'status' && (parts.length === 1 || parts.length === 2 && parts[1] === '--json')))
                throw new Error('invalid_command');
            const settings = indexSettingsForCommand(db, workspace);
            const calls = db.prepare('SELECT count(*) AS count,CASE WHEN count(input_tokens)=count(*) THEN sum(input_tokens) END AS inputTokens,CASE WHEN count(output_tokens)=count(*) THEN sum(output_tokens) END AS outputTokens,CASE WHEN count(duration_ms)=count(*) THEN sum(duration_ms) END AS durationMs FROM memory_index_calls WHERE workspace=? AND utc_day=?').get<{ count: number; inputTokens: number | null; outputTokens: number | null; durationMs: number | null }>(workspace, new Date().toISOString().slice(0, 10))!;
            const pending = db.prepare("SELECT (SELECT count(*) FROM memory_index_sources WHERE workspace=? AND state='pending') AS sources,(SELECT count(*) FROM memory_index_jobs WHERE workspace=? AND state='pending') AS jobs").get<{ sources: number; jobs: number }>(workspace, workspace)!;
            const bound = db.prepare('SELECT model_json FROM memory_index_settings WHERE workspace=?').get<{ model_json: string | null }>(workspace)?.model_json;
            const waitingReason = !pending.sources && !pending.jobs ? null : settings?.mode === 'off' ? 'mode_off' : !this.worker.options.llm ? 'model_unavailable' : !bound && pending.sources ? 'model_unknown' : calls.count >= this.config.dailyCalls ? 'daily_budget' : 'queued';
            return { settings, waiting: { ...pending, reason: waitingReason }, facts: db.prepare('SELECT role,state,count(*) AS count FROM memory_index_facts WHERE workspace=? GROUP BY role,state').all(workspace), sources: db.prepare('SELECT state,count(*) AS count FROM memory_index_sources WHERE workspace=? GROUP BY state').all(workspace), jobs: db.prepare("SELECT id,state,stage,reason,(SELECT count(*) FROM json_each(coalesce(j.verdicts_json,'[]')) v WHERE json_extract(v.value,'$.verdict')<>'supported') AS withheldCandidates FROM memory_index_jobs j WHERE workspace=? ORDER BY created_at DESC LIMIT 20").all(workspace), calls };
        }));
        if (!['', 'status'].includes(raw.trim().split(/\s+/)[0]!))
            this.worker.kick();
        return result;
    }
}
