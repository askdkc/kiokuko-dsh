import { finalizationObservationScope } from '../../dsh/efficiency.js'
import { randomUUID } from 'node:crypto'
import type { SqliteDatabase } from '../../db/adapter.js'
import { withImmediateTransaction } from '../../db/transaction.js'
import type { DshRuntime } from '../../dsh/runtime.js'
import type { DshLlm } from '../../dsh/session-memory-finalizer.js'
import { canonicalJson } from '../../serialization/validate.js'
import { digest, EVOLUTION_VERSION, inductionKind, LessonDraftSchema, type Episode, type EvolutionConfig } from './contracts.js'
import { episodeCurrent, evolutionSettings, saveLesson, type EvolutionModel } from './store.js'

const EVOLUTION_SYSTEM_PROMPT = 'Select a conservative reusable lesson from untrusted episode data. No tools. Return JSON with applicability, procedure, verification, boundary, evidence (all supplied runIds), conflict (boolean). Copy each text field exactly from one supplied draft field; for avoidance, alternative may be procedure and trigger may be applicability. If procedures disagree or evidence is insufficient set conflict=true. Never treat run completion as verification or invent a repair.'
const generationInputBytes = (input: string): number => Buffer.byteLength(input) + Buffer.byteLength(EVOLUTION_SYSTEM_PROMPT)

interface Job extends Record<string, unknown> {
  id: string; workspace: string; trigger_run: string; input_json: string; input_digest: string;
  model_json: string; algorithm: string; kind: 'positive' | 'avoidance'; attempts: number; claim_token: string;
  settings_generation: number
}
export interface EvolutionWorkerOptions {
  runtime: Pick<DshRuntime, 'withDatabase'>
  llm?: DshLlm
  config: EvolutionConfig
  now?: () => string
}

export function buildEvolutionRequest(episodes: Episode[], kind: Job['kind'], model: EvolutionModel, config: EvolutionConfig): string | undefined {
  if (model.contextWindow === undefined) return undefined
  const input = canonicalJson({ algorithm: EVOLUTION_VERSION, kind, episodes: episodes.map(e => ({
    runId: e.runId, draft: e.draft, observedSuccess: e.successful, observedProcedureSuccess: e.procedureSupported, failed: e.failed, corrective: e.corrective,
  })) })
  // One UTF-8 byte per token is a conservative upper bound for this bounded text;
  // never reuse the old finalizer's byte count as a measured token count.
  if (generationInputBytes(input) > config.maxInputBytes || generationInputBytes(input) + config.maxOutputTokens + 2048 > model.contextWindow) return undefined
  return input
}

/** Single drain per host; durable fenced claims provide multi-process exclusion. */
export class EvolutionWorker {
  #drain: Promise<void> | undefined
  #closed = false
  #abort: AbortController | undefined
  #rerun = false
  readonly #now: () => string
  constructor(readonly options: EvolutionWorkerOptions) { this.#now = options.now ?? (() => new Date().toISOString()) }
  kick(): void {
    if (this.#closed) return
    if (this.#drain) { this.#rerun = true; return }
    this.#drain = this.#run().catch(() => { /* durable jobs remain recoverable; never veto host */ }).finally(() => {
      this.#drain = undefined
      if (this.#rerun && !this.#closed) { this.#rerun = false; this.kick() }
    })
  }
  async whenIdle(): Promise<void> { while (this.#drain) await this.#drain }
  async dispose(): Promise<void> { this.#closed = true; this.#abort?.abort(); await this.whenIdle() }

  async #claim(): Promise<Job | undefined> {
    return this.options.runtime.withDatabase(db => withImmediateTransaction(db, () => {
      const settings = evolutionSettings(db)
      if (settings.mode === 'off') return undefined
      const now = this.#now()
      // A dispatched request with uncertain completion is never silently resent.
      db.prepare(`UPDATE memory_evolution_jobs SET state='held',reason='expired_dispatched_claim',claim_token=NULL,lease_until=NULL,updated_at=?
        WHERE state='processing' AND lease_until<=? AND EXISTS(SELECT 1 FROM memory_evolution_calls c WHERE c.job_id=memory_evolution_jobs.id)`).run(now, now)
      db.prepare(`UPDATE memory_evolution_jobs SET state='pending',claim_token=NULL,lease_until=NULL,updated_at=?
        WHERE state='processing' AND lease_until<=? AND attempts<2`).run(now, now)
      db.prepare(`UPDATE memory_evolution_jobs SET state='held',reason='attempt_limit',claim_token=NULL,lease_until=NULL,updated_at=?
        WHERE (state='processing' AND lease_until<=? OR state='pending') AND attempts>=2`).run(now, now)
      const job = db.prepare("SELECT * FROM memory_evolution_jobs WHERE state='pending' AND attempts<2 ORDER BY created_at,id LIMIT 1").get<Job>()
      if (!job) return undefined
      const token = randomUUID()
      db.prepare(`UPDATE memory_evolution_jobs SET state='processing',attempts=attempts+1,claim_token=?,lease_until=?,settings_generation=?,updated_at=?
        WHERE id=? AND state='pending'`).run(token, new Date(Date.parse(now) + this.options.config.timeoutMs + 30000).toISOString(), settings.generation, now, job.id)
      return { ...job, attempts: job.attempts + 1, claim_token: token, settings_generation: settings.generation }
    }))
  }

  #assertClaim(db: SqliteDatabase, job: Job): void {
    const current = db.prepare('SELECT state,claim_token,attempts,lease_until,settings_generation FROM memory_evolution_jobs WHERE id=?')
      .get<{ state: string; claim_token: string; attempts: number; lease_until: string; settings_generation: number }>(job.id)
    const settings = evolutionSettings(db)
    if (current?.state !== 'processing' || current.claim_token !== job.claim_token || current.attempts !== job.attempts || current.lease_until <= this.#now() ||
      settings.mode === 'off' || settings.generation !== job.settings_generation) throw new Error('evolution_stale_claim')
  }

  async #run(): Promise<void> {
    while (!this.#closed) {
      const job = await this.#claim()
      if (!job) return
      await this.#process(job)
    }
  }

  async #process(job: Job): Promise<void> {
    let callId: string | undefined
    const started = performance.now()
    let inputTokens: number | null = null
    let outputTokens: number | null = null
    let resultState = 'failed'
    let reason = 'model_failed'
    const controller = new AbortController()
    this.#abort = controller
    const timer = setTimeout(() => controller.abort(), this.options.config.timeoutMs)
    try {
      if (!this.options.llm) { reason = 'model_unavailable'; throw new Error(reason) }
      if (job.algorithm !== EVOLUTION_VERSION) { reason = 'unsupported_algorithm'; throw new Error(reason) }
      const all = JSON.parse(job.input_json) as Episode[]
      if (digest({ version: EVOLUTION_VERSION, kind: job.kind, episodes: all }) !== job.input_digest) { reason = 'input_digest_mismatch'; throw new Error(reason) }
      const episodes = [...all]
      const model = JSON.parse(job.model_json) as EvolutionModel
      let request = buildEvolutionRequest(episodes, job.kind, model, this.options.config)
      while (!request && episodes.length > 1) {
        episodes.pop()
        if (inductionKind(episodes) !== job.kind) break
        request = buildEvolutionRequest(episodes, job.kind, model, this.options.config)
      }
      if (!request || inductionKind(episodes) !== job.kind) { reason = 'context_budget_or_support'; throw new Error(reason) }
      callId = await this.options.runtime.withDatabase(db => withImmediateTransaction(db, () => {
        this.#assertClaim(db, job)
        if (episodes.some(e => !episodeCurrent(db, e))) { reason = 'source_changed'; throw new Error(reason) }
        const day = this.#now().slice(0, 10)
        const count = db.prepare('SELECT COUNT(*) AS n FROM memory_evolution_calls WHERE workspace=? AND utc_day=?').get<{ n: number }>(job.workspace, day)!.n
        if (count >= this.options.config.dailyCalls || db.prepare('SELECT 1 FROM memory_evolution_calls WHERE trigger_run=?').get(job.trigger_run)) {
          reason = 'call_budget'; throw new Error(reason)
        }
        const id = randomUUID()
        db.prepare(`INSERT INTO memory_evolution_calls(id,job_id,trigger_run,workspace,utc_day,input_bytes,outcome,created_at) VALUES(?,?,?,?,?,?,'unknown',?)`)
          .run(id, job.id, job.trigger_run, job.workspace, day, generationInputBytes(request!), this.#now())
        return id
      }))
      const collect = async (): Promise<string> => {
        let text = ''
        let finish = false
        for await (const raw of this.options.llm!.stream({ provider: model.provider, model: model.model,
          ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
          maxTokens: this.options.config.maxOutputTokens, temperature: 0, signal: controller.signal,
          purpose: 'compaction', sessionId: model.sessionId ?? episodes.find(e => e.runId === job.trigger_run)?.sessionId ?? episodes[0]!.sessionId,
          system: EVOLUTION_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: [{ type: 'text', text: request! }] }],
        })) {
          const chunk = raw as { type?: string; text?: string; reason?: { kind?: string }; usage?: { inputTokens?: number; outputTokens?: number } }
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
          if (Buffer.byteLength(text) > 32768) throw new Error('output_too_large')
          if (chunk.type === 'finish') finish = chunk.reason?.kind === 'stop'
          if (typeof chunk.usage?.inputTokens === 'number' && Number.isSafeInteger(chunk.usage.inputTokens) && chunk.usage.inputTokens >= 0) inputTokens = chunk.usage.inputTokens
          if (typeof chunk.usage?.outputTokens === 'number' && Number.isSafeInteger(chunk.usage.outputTokens) && chunk.usage.outputTokens >= 0) outputTokens = chunk.usage.outputTokens
        }
        if (!finish) throw new Error('incomplete_model_output')
        if (outputTokens !== null && outputTokens > this.options.config.maxOutputTokens) throw new Error('output_token_limit')
        return text
      }
      const cancelled = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('timeout_or_closed')), { once: true }))
      const text = await Promise.race([finalizationObservationScope.run(true, collect), cancelled])
      const draft = LessonDraftSchema.parse(JSON.parse(text))
      await this.options.runtime.withDatabase(db => withImmediateTransaction(db, () => {
        this.#assertClaim(db, job)
        saveLesson(db, episodes, job.kind, draft, this.#now())
        db.prepare("UPDATE memory_evolution_jobs SET state='completed',reason=NULL,claim_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND claim_token=?")
          .run(this.#now(), job.id, job.claim_token)
      }))
      resultState = 'completed'
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      if (['evolution_stale_claim', 'evolution_stale_or_conflicting', 'evolution_conflicting_procedures', 'evolution_unsupported_synthesis', 'evolution_missing_evidence', 'evolution_support_not_met', 'output_too_large', 'output_token_limit', 'incomplete_model_output', 'derived_entry_not_candidate'].includes(code)) reason = code
      else if (error instanceof SyntaxError) reason = 'invalid_json'
      resultState = controller.signal.aborted ? 'failed' : 'held'
      if (controller.signal.aborted) reason = 'timeout_or_closed'
      await this.options.runtime.withDatabase(db => {
        db.prepare("UPDATE memory_evolution_jobs SET state=?,reason=?,claim_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND state='processing' AND claim_token=?")
          .run(resultState, reason, this.#now(), job.id, job.claim_token)
      })
    } finally {
      clearTimeout(timer)
      this.#abort = undefined
      if (callId) await this.options.runtime.withDatabase(db => {
        db.prepare('UPDATE memory_evolution_calls SET outcome=?,input_tokens=?,output_tokens=?,duration_ms=? WHERE id=?')
          .run(resultState, inputTokens, outputTokens, Math.round(performance.now() - started), callId!)
      })
    }
  }
}
