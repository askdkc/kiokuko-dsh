import { assertCaptureAllowed, capturePolicy, watchCapture } from '../memory/capture-policy.js'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { parseCapsule, type DshLlm } from '../dsh/session-memory-finalizer.js'
import { recordEntryInTransaction } from '../memory/entries.js'
import { buildStructuredScope } from '../memory/structured-memory.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { findSecretInValue } from '../memory/secrets.js'
import { DeepStore } from './store.js'
import { budgetProblem, estimateRequestTokens } from './core/budget.js'
import { LegacyDeepConfigurationSchema, CandidateSchema, GoalNodeSchema, QualityNodeSchema } from './core/contracts.js'
import { deepMemoryRequestScope } from './memory-request.js'
import { currentArtifacts, changedSources } from './evidence.js'
import { abortableStream } from './abortable-stream.js'
import { processDeepSlots } from './slots.js'

export const DeepFinalizationSourceSchema = z.object({ kind: z.literal('deep-report'), workspace: z.string(), sessionId: z.string(), configuration: LegacyDeepConfigurationSchema,
  report: z.object({ reportId: z.string(), runId: z.string(), revision: z.number().int(), phase: z.string(), text: z.string().max(131_072), summary: z.string().max(8_192), protocolVersion: z.union([z.literal(1), z.literal(2)]),
    quality: z.array(z.object({ nodeId: z.string(), status: GoalNodeSchema.shape.status, checks: QualityNodeSchema.shape.checks, issues: QualityNodeSchema.shape.issues, review: QualityNodeSchema.shape.review, candidates: QualityNodeSchema.shape.candidates, receipt: GoalNodeSchema.shape.receipt }).strict()).max(128).optional() }).strict(),
  accepted: z.array(z.object({ nodeId: z.string(), revision: z.number().int(), candidate: CandidateSchema.nullable(), receipt: GoalNodeSchema.shape.receipt })).max(128),
}).strict()

/** A distinct finalizer source. No native parent request header or fabricated turn boundary. */
export class DeepMemoryFinalizer {
  readonly processId = randomUUID()
  #abort: AbortController | undefined
  constructor(readonly store: DeepStore, readonly llm: DshLlm | undefined, readonly delivered?: (sessionId: string) => PromiseLike<unknown>) {}
  async processNext(): Promise<boolean> {
    return false; // Historical Deep extraction jobs have no approval of an exact candidate.
  }
  abort(): void { this.#abort?.abort(new Error('Deep memory finalizer is closing')) }
}
