import { z } from 'zod'

export const DEEP_PROTOCOL_VERSION = 1 as const
export const DEEP_ROLES = ['planner', 'solver', 'critic', 'synthesizer'] as const
export type DeepRole = typeof DEEP_ROLES[number]
const id = z.string().min(1).max(256).regex(/^[^\p{Cc}]+$/u)
const text = z.string().min(1).max(32_768)
const strings = z.array(text).max(64)
export const DeepModelSchema = z.object({ provider: id, model: id, reasoningEffort: id.optional() }).strict()
export type DeepModel = z.infer<typeof DeepModelSchema>
export const DeepBudgetSchema = z.object({
  maxConcurrentAgents: z.number().int().min(1).max(8).default(3),
  maxDepth: z.number().int().min(0).max(8).default(4),
  maxNodes: z.number().int().min(1).max(128).default(32),
  maxChildrenPerNode: z.number().int().min(1).max(8).default(3),
  maxReplansPerNode: z.number().int().min(0).max(4).default(2),
  maxAgentJobs: z.number().int().min(0).max(256).default(48),
  maxModelRequests: z.number().int().min(0).max(512).default(80),
  maxTotalTokens: z.number().int().min(0).max(2_000_000).default(120_000),
  maxOutputTokensPerRequest: z.number().int().min(1).max(32_768).default(4_096),
  maxActiveSeconds: z.number().int().min(1).max(7_200).default(600),
}).strict()
export type DeepBudget = z.infer<typeof DeepBudgetSchema>
export const DeepRouteSchema = z.object({ provider: id, family: z.enum(['openai', 'deepseek', 'opencode-go', 'opencode-zen', 'openrouter', 'orcarouter', 'ollama', 'other']),
  connection: z.enum(['api', 'codex', 'local']), protocol: z.enum(['responses', 'chat-completions', 'messages', 'unknown']) }).strict()
export const DeepConfigurationSchema = z.object({
  roles: z.object({ planner: DeepModelSchema, solver: DeepModelSchema, critic: DeepModelSchema, synthesizer: DeepModelSchema }).strict(),
  reasoningMode: z.enum(['standard', 'quality']).optional(),
  alternativeSolver: DeepModelSchema.optional(),
  budget: DeepBudgetSchema.prefault({}),
  localProviders: z.array(id).max(128).default([]),
  routeBindings: z.array(DeepRouteSchema).max(128).default([]),
}).strict()
export type DeepConfiguration = z.infer<typeof DeepConfigurationSchema>
export const DeepThinkerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxConcurrentAgentsTotal: z.number().int().min(1).max(32).default(6),
  budget: DeepBudgetSchema.prefault({}),
}).strict()

export const EvidenceRefSchema = z.object({ artifactId: id, quote: z.string().min(1).max(4_096).optional() }).strict()
export const CandidateSchema = z.object({
  kind: z.literal('candidate'), answer: text,
  evidence: z.array(EvidenceRefSchema).max(64), assumptions: strings, unresolved: strings,
}).strict()
export type Candidate = z.infer<typeof CandidateSchema>
export const ChildProposalSchema = z.object({
  key: id, question: text, requirementIds: z.array(id).min(1).max(64),
  acceptanceCriteria: strings.min(1), assumptions: strings,
  dependsOn: z.array(id).max(8),
}).strict()
export const PlannerReplySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('leaf'), reason: text }).strict(),
  z.object({ kind: z.literal('decompose'), children: z.array(ChildProposalSchema).min(1).max(8), synthesis: text }).strict(),
  z.object({ kind: z.literal('blocked'), reason: text }).strict(),
])
export const SolverReplySchema = z.discriminatedUnion('kind', [
  CandidateSchema,
  z.object({ kind: z.literal('needs-decomposition'), reason: text }).strict(),
  z.object({ kind: z.literal('blocked'), reason: text }).strict(),
])
export const CriticReplySchema = z.object({
  kind: z.enum(['supported', 'reconsider', 'unresolved']),
  requirementIds: z.array(id).min(1).max(64), reason: text,
  evidence: z.array(EvidenceRefSchema).max(64),
}).strict()
export const SynthesizerReplySchema = CandidateSchema
export type PlannerReply = z.infer<typeof PlannerReplySchema>
export type AgentReply = PlannerReply | z.infer<typeof SolverReplySchema> | z.infer<typeof CriticReplySchema>
export const ReplySchemas = { planner: PlannerReplySchema, solver: SolverReplySchema, critic: CriticReplySchema, synthesizer: SynthesizerReplySchema }

// Version 2 adds bounded comparison without changing the version 1 worker schemas.
export const QualityCheckSchema = z.object({ id, key: id, requirementId: id, text, evidenceNeeded: text }).strict()
const ProposedCheckSchema = QualityCheckSchema.omit({ id: true })
export const QualityPlanSchema = z.object({ kind: z.literal('quality-plan'), decision: z.enum(['leaf', 'decompose', 'blocked']),
  checks: z.array(ProposedCheckSchema).max(64), children: z.array(ChildProposalSchema.extend({ checkKeys: z.array(id).min(1).max(64) })).max(8), reason: text, synthesis: text }).strict()
export const QualityPlanReviewSchema = CriticReplySchema.extend({ kind: z.literal('quality-plan-review'), verdict: z.enum(['supported', 'reconsider', 'unresolved']), checkIds: z.array(id).max(64) })
export const QualityCandidateSchema = CandidateSchema.extend({ kind: z.literal('quality-candidate'),
  findings: z.array(z.object({ checkId: id, conclusion: text, evidence: z.array(EvidenceRefSchema).max(64), unresolved: z.boolean() }).strict()).min(1).max(64) })
export const QualityIssueSchema = z.object({ id, checkId: id, text }).strict()
export const QualityReviewSchema = z.object({ kind: z.literal('quality-review'),
  action: z.enum(['select', 'repair', 'synthesize', 'replan', 'unresolved']), selectedCandidateId: id.nullable(),
  requirementIds: z.array(id).min(1).max(64), reason: text, evidence: z.array(EvidenceRefSchema).max(64),
  evaluations: z.array(z.object({ candidateId: id, checkId: id, verdict: z.enum(['supported', 'contradicted', 'unresolved']), reason: text, evidence: z.array(EvidenceRefSchema).max(64) }).strict()).max(192),
  agreement: z.array(z.object({ checkId: id, kind: z.enum(['agreement', 'contradiction', 'complementary', 'unknown']), reason: text }).strict()).max(64),
  issues: z.array(z.object({ checkId: id, text }).strict()).max(64),
  resolutions: z.array(z.object({ issueId: id, status: z.enum(['resolved', 'unresolved']), reason: text, evidence: z.array(EvidenceRefSchema).max(64) }).strict()).max(64),
}).strict()
export const QualityPhaseSchema = z.enum(['plan', 'plan-review', 'draft-a', 'draft-b', 'compare', 'repair', 'synthesize', 'compose', 'final-review'])
export const QualityNodeSchema = z.object({
  phase: QualityPhaseSchema, checks: z.array(QualityCheckSchema).max(64), inheritedChecks: z.array(QualityCheckSchema).max(64),
  plan: QualityPlanSchema.nullable(), correctionUsed: z.boolean(),
  candidates: z.array(z.object({ id, attemptId: id, model: DeepModelSchema, reply: QualityCandidateSchema }).strict()).max(3),
  issues: z.array(QualityIssueSchema).max(64), review: QualityReviewSchema.nullable(),
  commonArtifactIds: z.array(id).max(256).nullable(),
}).strict()
export type QualityNode = z.infer<typeof QualityNodeSchema>
export type QualityReply = z.infer<typeof QualityPlanSchema> | z.infer<typeof QualityPlanReviewSchema> | z.infer<typeof QualityCandidateSchema> | z.infer<typeof QualityReviewSchema>
export const QualityJobSchema = z.object({ protocolVersion: z.literal(2), phase: QualityPhaseSchema, model: DeepModelSchema,
  candidateId: id.nullable(), poolDigest: id, commonArtifactIds: z.array(id).max(256) }).strict()
export type QualityJob = z.infer<typeof QualityJobSchema>
const ReceiptV1Schema = z.object({ inputDigest: id, evidenceDigest: id, verifierVersion: z.literal(1), assessment: z.enum(['source-supported', 'analytical']) }).strict()
const ReceiptV2Schema = ReceiptV1Schema.extend({ verifierVersion: z.literal(2), selectedCandidateId: id, poolDigest: id,
  candidates: z.array(z.object({ id, attemptId: id, model: DeepModelSchema }).strict()).min(1).max(3), review: QualityReviewSchema })

export const GoalNodeSchema = z.object({
  id, parentId: id.nullable(), revision: z.number().int().positive(),
  question: text, requirementIds: z.array(id).min(1).max(64), acceptanceCriteria: strings.min(1), assumptions: strings,
  dependencies: z.array(id).max(128), depth: z.number().int().min(0), replans: z.number().int().min(0),
  status: z.enum(['planning', 'ready', 'verifying-plan', 'waiting-children', 'composing', 'verifying', 'accepted', 'unresolved', 'superseded']),
  activeAttemptId: id.nullable(), candidate: CandidateSchema.nullable(),
  proposal: PlannerReplySchema.nullable(), reason: z.string().max(32_768),
  quality: QualityNodeSchema.optional(),
  receipt: z.union([ReceiptV1Schema, ReceiptV2Schema]).nullable(),
}).strict()
export type GoalNode = z.infer<typeof GoalNodeSchema>
export const DeepStateSchema = z.object({
  protocolVersion: z.union([z.literal(1), z.literal(2)]), runId: id, startId: id, workspace: id, sessionId: id, rootPath: text,
  revision: z.number().int().min(0), requirementRevision: z.number().int().positive(),
  ownerEpoch: z.number().int().min(0), ownerId: id.nullable(), leaseUntil: z.number().nonnegative(),
  phase: z.enum(['ready', 'running', 'paused', 'answered', 'partial', 'blocked', 'failed', 'cancelled']),
  task: text, constraints: strings, context: z.string().max(32_768), reason: z.string().max(32_768),
  configuration: DeepConfigurationSchema,
  usage: z.object({ jobs: z.number().int().nonnegative(), requests: z.number().int().nonnegative(), tokens: z.number().nonnegative(), reservedTokens: z.number().nonnegative(), estimated: z.boolean(), activeMs: z.number().nonnegative(), activeSince: z.number().nonnegative().nullable() }).strict(),
  nodes: z.array(GoalNodeSchema).min(1).max(128),
  pendingInputs: z.array(z.object({ id, text, source: z.enum(['user', 'plugin']), consumed: z.boolean() }).strict()).max(64),
}).strict().superRefine((state, ctx) => {
  const quality = state.protocolVersion === 2
  if (quality !== (state.configuration.reasoningMode === 'quality') || quality && !state.configuration.alternativeSolver || state.nodes.some(node => quality !== !!node.quality)) ctx.addIssue({ code: 'custom', message: 'Deep protocol, configuration and node modes must match' })
})
export type DeepState = z.infer<typeof DeepStateSchema>
export type DeepPhase = DeepState['phase']
export const terminal = (phase: DeepPhase): boolean => ['answered', 'partial', 'blocked', 'failed', 'cancelled'].includes(phase)
export interface DeepJob { readonly nodeId: string; readonly nodeRevision: number; readonly role: DeepRole; readonly inputDigest: string; readonly prompt: string; readonly inputArtifactIds: readonly string[]; readonly quality?: QualityJob }
export const DeepArtifactSchema = z.object({ id, attemptId: id.optional(), runId: id, nodeId: id, nodeRevision: z.number().int().positive(), requirementRevision: z.number().int().positive(), path: text,
  content: z.string().max(16_384), digest: id, sourceDigest: id, startLine: z.number().int().positive(), endLine: z.number().int().positive() }).strict()
export type DeepArtifact = z.infer<typeof DeepArtifactSchema>
