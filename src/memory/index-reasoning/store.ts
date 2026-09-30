import type { SqliteDatabase } from '../../db/adapter.js';
import { readEntry, recordEntryInTransaction, type EntryRecord } from '../entries.js';
import { capturePolicy } from '../capture-policy.js';
import { IndexDraft, IndexManifest, INDEX_ALGORITHM, indexDigest, normalizeEntity, entityPresent, type IndexModel, type IndexReasoningConfig } from './contracts.js';
import { randomUUID } from 'node:crypto';
import { findSecret } from '../secrets.js';
const listeners = new Set<() => void>();
let wakeQueued = false;
export function watchIndexQueue(wake: () => void): () => void {
    listeners.add(wake);
    return () => {
        listeners.delete(wake);
    };
}
function wakeIndexQueue(): void {
    if (wakeQueued)
        return;
    wakeQueued = true;
    queueMicrotask(() => {
        wakeQueued = false;
        for (const wake of listeners)
            wake();
    });
}
export function indexInstalled(db: SqliteDatabase): boolean {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_index_facts'").get();
}
export function indexSettings(db: SqliteDatabase, workspace: string) {
    if (!indexInstalled(db))
        return undefined;
    return db.prepare('SELECT mode,generation,index_generation,config_digest FROM memory_index_settings WHERE workspace=?').get<{
        mode: string;
        generation: number;
        index_generation: number;
        config_digest: string | null;
    }>(workspace);
}
export function configureIndex(db: SqliteDatabase, workspace: string, mode: string, config?: IndexReasoningConfig): void {
    const digest = config ? indexDigest(config) : null;
    if (config && indexSettings(db, workspace)?.config_digest === digest)
        return;
    db.prepare('INSERT OR IGNORE INTO memory_index_settings(workspace,mode) VALUES(?,?)').run(workspace, mode);
    db.prepare('UPDATE memory_index_settings SET mode=?,config_digest=coalesce(?,config_digest),generation=generation+1 WHERE workspace=? AND (mode<>? OR (? IS NOT NULL AND config_digest IS NOT ?))').run(mode, digest, workspace, mode, digest, digest);
}
export function sourceAllowed(db: SqliteDatabase, e: EntryRecord): boolean {
    if (findSecret([e.title, e.summary ?? '', e.body, JSON.stringify(e.provenance)].join('\n')))
        return false;
    if (e.status === 'superseded' || e.workspace === 'global' || e.provenance.type === 'memory-index-reasoning' || e.provenance.type === 'memory-evolution' || ['external_skill', 'source_sync'].includes(String(e.provenance.type)))
        return false;
    if (db.prepare('SELECT 1 FROM memory_index_facts WHERE entry_id=? UNION ALL SELECT 1 FROM memory_derivations WHERE entry_id=? LIMIT 1').get(e.id, e.id))
        return false;
    if (e.scope.visibility !== 'project')
        return false;
    if (db.prepare("SELECT 1 FROM context_feedback f JOIN context_delivery_entries d ON d.delivery_id=f.delivery_id AND d.entry_id=f.entry_id WHERE f.entry_id=? AND d.entry_revision=? AND f.verdict IN ('stale','conflicting') LIMIT 1").get(e.id, e.revision))
        return false;
    const runId = e.provenance.runId;
    if (typeof runId === 'string') {
        const r = db.prepare('SELECT dsh_session_id FROM ledger_runs WHERE run_id=? AND workspace=?').get<{
            dsh_session_id: string;
        }>(runId, e.workspace);
        if (!r || capturePolicy(db, e.workspace, r.dsh_session_id).mode !== 'allowed')
            return false;
    }
    return true;
}
/** A bounded, resumable reconciliation; excluded and derived rows cannot starve older originals. */
export function reconcileIndexSources(db: SqliteDatabase, workspace: string): void {
    if (indexSettings(db, workspace)?.mode === 'off')
        return;
    const rows = db.prepare("SELECT e.id FROM entries e JOIN entry_revisions r ON r.entry_id=e.id AND r.revision=e.current_revision WHERE e.workspace=? AND e.status<>'superseded' AND coalesce(json_extract(r.provenance_json,'$.type'),'') NOT IN ('memory-index-reasoning','memory-evolution','external_skill','source_sync') AND NOT EXISTS(SELECT 1 FROM memory_index_sources s WHERE s.entry_id=e.id AND s.revision=e.current_revision) ORDER BY e.updated_at DESC,e.id LIMIT 100").all<{
        id: string;
    }>(workspace);
    for (const row of rows) {
        const e = readEntry(db, { workspace, entryId: row.id });
        enqueueIndexSource(db, e, 0);
        if (!sourceAllowed(db, e))
            db.prepare("INSERT OR IGNORE INTO memory_index_sources(entry_id,revision,workspace,content_hash,state) VALUES(?,?,?,?,'held')").run(e.id, e.revision, workspace, e.contentHash);
    }
}
export function enqueueIndexSource(db: SqliteDatabase, e: EntryRecord, priority = 1): void {
    if (!indexInstalled(db) || !sourceAllowed(db, e))
        return;
    db.prepare('INSERT OR IGNORE INTO memory_index_sources(entry_id,revision,workspace,content_hash,priority) VALUES(?,?,?,?,?)').run(e.id, e.revision, e.workspace, e.contentHash, priority);
    wakeIndexQueue();
}
export function validateDraft(db: SqliteDatabase, workspace: string, raw: unknown): IndexDraft {
    const d = IndexDraft.parse(raw);
    if (d.sources.length !== (d.role === 'atomic' ? 1 : 2))
        throw new Error('source_count');
    const hashes = new Set<string>(), ids = new Set<string>();
    const contents = new Set<string>(), excerpts = new Set<string>();
    for (const s of d.sources) {
        const e = readEntry(db, { workspace, entryId: s.entryId });
        if (!sourceAllowed(db, e) || e.revision !== s.revision || e.contentHash !== s.contentHash || !e.body.includes(s.supportingText))
            throw new Error('source_changed');
        hashes.add(e.contentHash);
        ids.add(e.id);
        contents.add(normalizeEntity(e.body));
        excerpts.add(normalizeEntity(s.supportingText));
    }
    if (hashes.size !== d.sources.length || ids.size !== d.sources.length || contents.size !== d.sources.length || excerpts.size !== d.sources.length)
        throw new Error('duplicate_source');
    for (const entity of d.entities)
        if (!d.sources.some(s => entityPresent(s.supportingText, entity.value)))
            throw new Error('ungrounded_entity');
    if (d.role === 'bridge' && !d.entities.some(entity => d.sources.every(s => entityPresent(s.supportingText, entity.value))))
        throw new Error('missing_shared_entity');
    return d;
}
export function readIndexManifest(db: SqliteDatabase, e: Pick<EntryRecord, 'id' | 'revision' | 'workspace'>): IndexManifest | null {
    if (!indexInstalled(db))
        return null;
    const row = db.prepare('SELECT manifest_json,input_digest FROM memory_index_facts WHERE entry_id=? AND revision=? AND workspace=?').get<{
        manifest_json: string;
        input_digest: string;
    }>(e.id, e.revision, e.workspace);
    if (!row)
        return null;
    const m = IndexManifest.parse(JSON.parse(row.manifest_json));
    const { inputDigest, ...bound } = m;
    if (indexDigest(bound) !== inputDigest || inputDigest !== row.input_digest)
        throw new Error('invalid_index_manifest');
    return m;
}
export function indexFactEligible(db: SqliteDatabase, e: EntryRecord, forGeneration = false): boolean {
    if (!indexInstalled(db))
        return e.provenance.type !== 'memory-index-reasoning';
    const derived = e.provenance.type === 'memory-index-reasoning' || !!db.prepare('SELECT 1 FROM memory_index_facts WHERE entry_id=? LIMIT 1').get(e.id);
    if (!derived)
        return true;
    if (e.provenance.type !== 'memory-index-reasoning')
        return false;
    try {
        const m = readIndexManifest(db, e), mode = indexSettings(db, e.workspace)?.mode;
        if (!m || !(mode === 'active' || forGeneration && mode === 'observe') || e.status !== 'candidate' || e.trustLevel !== 'untrusted')
            return false;
        if (db.prepare("SELECT 1 FROM context_feedback f JOIN context_delivery_entries d ON d.delivery_id=f.delivery_id AND d.entry_id=f.entry_id WHERE f.entry_id=? AND d.entry_revision=? AND f.verdict IN ('stale','conflicting') LIMIT 1").get(e.id, e.revision))
            return false;
        const r = db.prepare("SELECT state FROM memory_index_facts WHERE entry_id=? AND revision=?").get<{
            state: string;
        }>(e.id, e.revision);
        if (r?.state !== 'ready')
            return false;
        validateDraft(db, e.workspace, { role: m.role, text: e.body, entities: m.entities, applicability: m.applicability, sources: m.sources });
        return true;
    }
    catch {
        return false;
    }
}
export function saveIndexFact(db: SqliteDatabase, workspace: string, raw: unknown): EntryRecord {
    const d = validateDraft(db, workspace, raw);
    const bound = { version: 1 as const, role: d.role, entities: d.entities, applicability: d.applicability, sources: [...d.sources].sort((a, b) => a.entryId.localeCompare(b.entryId)), algorithmVersion: INDEX_ALGORITHM };
    const inputDigest = indexDigest(bound), manifest = { ...bound, inputDigest };
    const old = db.prepare('SELECT entry_id FROM memory_index_facts WHERE workspace=? AND input_digest=?').get<{
        entry_id: string;
    }>(workspace, inputDigest);
    if (old) {
        const e = readEntry(db, { workspace, entryId: old.entry_id });
        if (e.body !== d.text)
            throw new Error('index_replay_conflict');
        return e;
    }
    const e = recordEntryInTransaction(db, { workspace, kind: 'fact', title: `${d.role}: ${d.text.slice(0, 150)}`, body: d.text, scope: { visibility: 'project', retrievalScope: 'project-only' }, provenance: { type: 'memory-index-reasoning', reference: inputDigest }, createdBy: 'kiokuko-index-reasoning', trustLevel: 'untrusted' });
    db.prepare("INSERT INTO memory_index_facts VALUES(?,?,?,?,?,?,'ready')").run(e.id, e.revision, workspace, d.role, JSON.stringify(manifest), inputDigest);
    for (const entity of d.entities)
        db.prepare('INSERT OR IGNORE INTO memory_index_entities VALUES(?,?,?,?,?)').run(e.id, e.revision, workspace, entity.type, normalizeEntity(entity.value));
    db.prepare('UPDATE memory_index_settings SET index_generation=index_generation+1 WHERE workspace=?').run(workspace);
    return e;
}
export function reserveIndexJob(db: SqliteDatabase, workspace: string, model: IndexModel, now = new Date().toISOString()): void {
    if (indexSettings(db, workspace)?.mode === 'off')
        return;
    const rows = db.prepare("SELECT s.entry_id,s.priority FROM memory_index_sources s JOIN entries e ON e.id=s.entry_id AND e.current_revision=s.revision WHERE s.workspace=? AND s.state='pending' ORDER BY s.priority DESC,e.updated_at DESC,s.rowid DESC LIMIT 4").all<{
        entry_id: string;
        priority: number;
    }>(workspace);
    const sources = rows.flatMap(r => {
        try {
            const e = readEntry(db, { workspace, entryId: r.entry_id });
            if (sourceAllowed(db, e))
                return [e];
        }
        catch {
        }
        db.prepare("UPDATE memory_index_sources SET state='held' WHERE entry_id=? AND state='pending'").run(r.entry_id);
        return [];
    });
    if (!sources.length)
        return;
    const input = JSON.stringify(sources), digest = indexDigest(sources.map(e => [e.id, e.revision, e.contentHash]));
    if (db.prepare('SELECT 1 FROM memory_index_jobs WHERE workspace=? AND input_digest=?').get(workspace, digest))
        return;
    const priority = Math.max(...rows.filter(r => sources.some(e => e.id === r.entry_id)).map(r => r.priority));
    db.prepare('INSERT OR IGNORE INTO memory_index_jobs(id,workspace,input_json,input_digest,model_json,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), workspace, input, digest, JSON.stringify(model), priority, now, now);
    for (const e of sources)
        db.prepare("UPDATE memory_index_sources SET state='scheduled' WHERE entry_id=? AND revision=?").run(e.id, e.revision);
}
export function indexPeers(db: SqliteDatabase, workspace: string, drafts: IndexDraft[]): {
    drafts: IndexDraft[];
    sources: EntryRecord[];
} {
    const peers: IndexDraft[] = [], sources = new Map<string, EntryRecord>(), roots = new Set(drafts.flatMap(d => d.sources.map(s => s.entryId)));
    for (const entity of drafts.flatMap(d => d.entities)) {
        const rows = db.prepare("SELECT DISTINCT e.id FROM memory_index_entities n JOIN entries e ON e.id=n.entry_id AND e.current_revision=n.revision JOIN memory_index_facts f ON f.entry_id=e.id AND f.revision=e.current_revision WHERE n.workspace=? AND n.type=? AND n.value=? AND f.role='atomic' ORDER BY e.id LIMIT 8").all<{
            id: string;
        }>(workspace, entity.type, normalizeEntity(entity.value));
        for (const r of rows) {
            const e = readEntry(db, { workspace, entryId: r.id });
            if (!indexFactEligible(db, e, true))
                continue;
            const m = readIndexManifest(db, e)!;
            if (m.sources.some(s => roots.has(s.entryId)))
                continue;
            if (peers.some(p => indexDigest(p.sources) === indexDigest(m.sources)))
                continue;
            if (peers.length >= 8)
                break;
            peers.push({ role: 'atomic', text: e.body, applicability: m.applicability, entities: m.entities, sources: m.sources });
            for (const source of m.sources)
                sources.set(source.entryId, readEntry(db, { workspace, entryId: source.entryId }));
        }
    }
    return { drafts: peers, sources: [...sources.values()] };
}
