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

export const GoalNodeSchema = z.object({
  id, parentId: id.nullable(), revision: z.number().int().positive(),
  question: text, requirementIds: z.array(id).min(1).max(64), acceptanceCriteria: strings.min(1), assumptions: strings,
  dependencies: z.array(id).max(128), depth: z.number().int().min(0), replans: z.number().int().min(0),
  status: z.enum(['planning', 'ready', 'verifying-plan', 'waiting-children', 'composing', 'verifying', 'accepted', 'unresolved', 'superseded']),
  activeAttemptId: id.nullable(), candidate: CandidateSchema.nullable(),
  proposal: PlannerReplySchema.nullable(), reason: z.string().max(32_768),
  receipt: z.object({ inputDigest: id, evidenceDigest: id, verifierVersion: z.literal(1), assessment: z.enum(['source-supported', 'analytical']) }).strict().nullable(),
}).strict()
export type GoalNode = z.infer<typeof GoalNodeSchema>
export const DeepStateSchema = z.object({
  protocolVersion: z.literal(1), runId: id, startId: id, workspace: id, sessionId: id, rootPath: text,
  revision: z.number().int().min(0), requirementRevision: z.number().int().positive(),
  ownerEpoch: z.number().int().min(0), ownerId: id.nullable(), leaseUntil: z.number().nonnegative(),
  phase: z.enum(['ready', 'running', 'paused', 'answered', 'partial', 'blocked', 'failed', 'cancelled']),
  task: text, constraints: strings, context: z.string().max(32_768), reason: z.string().max(32_768),
  configuration: DeepConfigurationSchema,
  usage: z.object({ jobs: z.number().int().nonnegative(), requests: z.number().int().nonnegative(), tokens: z.number().nonnegative(), reservedTokens: z.number().nonnegative(), estimated: z.boolean(), activeMs: z.number().nonnegative(), activeSince: z.number().nonnegative().nullable() }).strict(),
  nodes: z.array(GoalNodeSchema).min(1).max(128),
  pendingInputs: z.array(z.object({ id, text, source: z.enum(['user', 'plugin']), consumed: z.boolean() }).strict()).max(64),
}).strict()
export type DeepState = z.infer<typeof DeepStateSchema>
export type DeepPhase = DeepState['phase']
export const terminal = (phase: DeepPhase): boolean => ['answered', 'partial', 'blocked', 'failed', 'cancelled'].includes(phase)
export interface DeepJob { readonly nodeId: string; readonly nodeRevision: number; readonly role: DeepRole; readonly inputDigest: string; readonly prompt: string; readonly inputArtifactIds: readonly string[] }
export const DeepArtifactSchema = z.object({ id, runId: id, nodeId: id, nodeRevision: z.number().int().positive(), requirementRevision: z.number().int().positive(), path: text,
  content: z.string().max(16_384), digest: id, sourceDigest: id, startLine: z.number().int().positive(), endLine: z.number().int().positive() }).strict()
export type DeepArtifact = z.infer<typeof DeepArtifactSchema>
