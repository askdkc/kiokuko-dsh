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
    return; // Existing indexed memories remain readable; no automatic derivation.
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
    return;
  }
    /**
     * Trusted native host only. The synchronous callback must verify the live
     * agent/session/workspace; it also gates later commands for this binding.
     * Conversation admission never creates a task or bypasses source checks.
     */
    async admitConversation(workspace: string, sessionId: string, envelope: unknown, assertCurrent: () => boolean): Promise<void> {
    return;
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
    return { recorded: false, workMayContinue: true, reason: 'post_task_memory_review_required' };
  }
}
