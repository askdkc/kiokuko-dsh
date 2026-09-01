import * as z from 'zod/v4';
import { TASK_TYPES } from '../akinator/types.js';
import { TASK_ANSWER_CONTRACT_FRAGMENT } from '../ledger/checkpoint-contract.js';
import { memoryCheckpointInputSchema } from '../memory/checkpoint-contract.js';
import { absoluteCwdSchema } from '../repository/cwd-schema.js';
import {
  adviceReadSchema,
  adviceSubmissionSchema,
  ennoAnswerSchema,
  finishSchema,
  idealSubmissionSchema,
  meditationSubmissionSchema,
  planSubmissionSchema,
  verificationPrepareSchema,
  workReportSchema,
} from '../enno-oduno/schemas.js';

export const MODEL_TOOL_OPERATION_NAMES = [
  'task_prepare',
  'task_answer',
  'enno_plan_submit',
  'enno_ideal_submit',
  'enno_advice_submit',
  'enno_advice_read',
  'enno_answer',
  'enno_work_report',
  'enno_verify_prepare',
  'enno_finish',
  'enno_meditation_submit',
  'curator_check',
  'curator_globalize',
  'memory_checkpoint',
] as const;

export type ModelToolOperationName = (typeof MODEL_TOOL_OPERATION_NAMES)[number];

export type ModelToolOwner = 'kiokuko-core';
export type ModelToolExposure = 'host-only' | 'model-facing';

function canonicalIdentity(maximum: number, label: string) {
  return z.string().min(1).max(maximum).refine(
    (value) => value.trim() === value && !/\p{Cc}/u.test(value),
    { message: `${label} must be a canonical bounded identity` },
  );
}

const profileField = z.enum(['taskType', 'target', 'expected', 'constraints']);
const requestId = canonicalIdentity(256, 'requestId');
const runId = canonicalIdentity(256, 'runId');
const clientSessionId = canonicalIdentity(256, 'client.sessionId');
const intakeSessionId = canonicalIdentity(200, 'sessionId');
const workspaceId = canonicalIdentity(256, 'workspace');
const entryId = canonicalIdentity(256, 'entryId');
const capabilityCatalog = z.array(z.unknown()).describe("Capability catalog contract: Array<{kind:'skill'|'mcp_tool';name:string;description?:string}>. Every item must include its kind and canonical name; description is an optional short one- or two-sentence summary. Any malformed or dropped item makes catalog availability unknown so required capabilities fail closed.");
const profileHints = z.object({
  taskType: z.enum(TASK_TYPES).nullable().optional(),
  target: z.string().trim().max(4000).nullable().optional(),
  expected: z.string().trim().max(4000).nullable().optional(),
  constraints: z.string().trim().max(4000).nullable().optional(),
}).strict();

export const taskPrepareInputSchema = z.object({
  soulRead: z.literal(true).describe('Required self-attestation that the client model read the complete exact local kiokuko-soul SKILL.md for this logical request before calling task_prepare; this is not remote proof of cognition'),
  requestId: requestId.describe('Opaque identity for this logical user request. Use a new value for every new request and reuse it only for an exact retry; the raw value is not stored'),
  task: z.string().trim().min(1).max(64 * 1024).describe('The user task, without hidden reasoning or full transcripts'),
  cwd: absoluteCwdSchema.optional().describe('Absolute current working directory; defaults to the MCP process cwd and is returned in canonical form through executionContext'),
  profileHints: profileHints.optional().describe('Task type, target, success condition, and constraints inferred from current evidence'),
  capabilities: capabilityCatalog.optional().describe("Complete capability descriptors for every capability available in this client as Array<{kind:'skill'|'mcp_tool';name:string;description?:string}>. Every item must include its kind and canonical name; description is optional and bounded. An explicit empty array means known-empty; omission or any malformed/dropped item means unknown. The catalog is ephemeral and never stored"),
  client: z.object({ kind: z.string().trim().min(1).max(200).optional(), version: z.string().trim().min(1).max(100).optional(), sessionId: clientSessionId.optional() }).strict().optional().describe('Optional explicit client routing metadata. Enno-Oduno normally identifies Codex, Claude Code, or OpenCode from the MCP initialize clientInfo and rejects a contradictory supported-client hint. The host session ID is not authorization ownership: continuation prefers the current opaque route-epoch-bound resume token, otherwise a matching hook may reroute the single unambiguous active run in the canonical repository when no WorkUnit execution lease is active.'),
  maxContextChars: z.number().int().min(1000).max(50_000).default(12_000).describe('Maximum characters for each bounded context lane; this normalized value is bound to the run'),
}).strict();

export const taskAnswerInputSchema = z.object({
  sessionId: intakeSessionId,
  runId: runId.describe('Required run ID returned by task_prepare'),
  questionId: profileField,
  value: z.string().trim().min(1).max(64 * 1024).describe(TASK_ANSWER_CONTRACT_FRAGMENT),
  cwd: absoluteCwdSchema.optional().describe('Absolute current working directory; defaults to the MCP process cwd and is returned in canonical form through executionContext'),
  capabilities: capabilityCatalog.optional().describe("Complete current client capability catalog as Array<{kind:'skill'|'mcp_tool';name:string;description?:string}>. Repeat the exact list from task_prepare. Every item must include its kind and canonical name; description is optional and bounded. Any malformed or dropped item makes availability unknown. The catalog is ephemeral and never stored"),
  maxContextChars: z.number().int().min(1000).max(50_000).default(12_000).describe('Must match the context budget bound by task_prepare'),
}).strict();

export const curatorCheckInputSchema = z.object({
  cwd: absoluteCwdSchema.optional().describe('Absolute current working directory; defaults to the MCP process cwd'),
  workspace: workspaceId.optional().describe('Exact project workspace; normally omit and resolve from cwd'),
  limit: z.number().int().min(1).max(20).default(5),
  includeUnready: z.boolean().default(false).describe('Include lower-evidence candidates for manual inspection; automated permission prompts should leave this false'),
}).strict();

export const curatorGlobalizeInputSchema = z.object({
  workspace: workspaceId,
  entryId,
  expectedRevision: z.number().int().min(1),
  confirmed: z.literal(true).describe('Must be true only after explicit user approval in the current conversation'),
}).strict();

export const MODEL_TOOL_INPUT_SCHEMAS = {
  task_prepare: taskPrepareInputSchema,
  task_answer: taskAnswerInputSchema,
  enno_plan_submit: planSubmissionSchema,
  enno_ideal_submit: idealSubmissionSchema,
  enno_advice_submit: adviceSubmissionSchema,
  enno_advice_read: adviceReadSchema,
  enno_answer: ennoAnswerSchema,
  enno_work_report: workReportSchema,
  enno_verify_prepare: verificationPrepareSchema,
  enno_finish: finishSchema,
  enno_meditation_submit: meditationSubmissionSchema,
  curator_check: curatorCheckInputSchema,
  curator_globalize: curatorGlobalizeInputSchema,
  memory_checkpoint: memoryCheckpointInputSchema,
} as const satisfies Record<ModelToolOperationName, z.ZodType>;

export interface ModelToolContract {
  readonly name: ModelToolOperationName;
  readonly owner: ModelToolOwner;
  readonly exposure: ModelToolExposure;
  readonly inputSchema: z.ZodType;
  readonly hostOwnedFields: readonly string[];
}

const commonIdentityFields = ['runId', 'workspace', 'orchestrationId', 'resumeToken', 'expectedRevision', 'idempotencyKey'] as const;

export const MODEL_TOOL_CONTRACTS = [
  { name: 'task_prepare', owner: 'kiokuko-core', exposure: 'host-only', inputSchema: taskPrepareInputSchema, hostOwnedFields: ['soulRead', 'requestId', 'task', 'cwd', 'profileHints', 'capabilities', 'client', 'maxContextChars'] },
  { name: 'task_answer', owner: 'kiokuko-core', exposure: 'host-only', inputSchema: taskAnswerInputSchema, hostOwnedFields: ['sessionId', 'runId', 'questionId', 'value', 'cwd', 'capabilities', 'maxContextChars'] },
  { name: 'enno_plan_submit', owner: 'kiokuko-core', exposure: 'model-facing', inputSchema: planSubmissionSchema, hostOwnedFields: [...commonIdentityFields, 'advisoryRoundDigest', 'advisoryDisposition', 'recoveryAction', 'capabilities'] },
  { name: 'enno_ideal_submit', owner: 'kiokuko-core', exposure: 'model-facing', inputSchema: idealSubmissionSchema, hostOwnedFields: [...commonIdentityFields, 'advisoryRoundDigest', 'advisoryDisposition'] },
  { name: 'enno_advice_submit', owner: 'kiokuko-core', exposure: 'host-only', inputSchema: adviceSubmissionSchema, hostOwnedFields: ['runId', 'workspace', 'orchestrationId', 'resumeToken', 'expectedRevision', 'mutationRevision', 'idempotencyKey', 'phase', 'allowlistedContext', 'contributions'] },
  { name: 'enno_advice_read', owner: 'kiokuko-core', exposure: 'host-only', inputSchema: adviceReadSchema, hostOwnedFields: ['runId', 'workspace', 'orchestrationId', 'resumeToken', 'expectedRevision', 'advisoryRoundDigest'] },
  { name: 'enno_answer', owner: 'kiokuko-core', exposure: 'host-only', inputSchema: ennoAnswerSchema, hostOwnedFields: [...commonIdentityFields, 'action', 'requestedChanges'] },
  { name: 'enno_work_report', owner: 'kiokuko-core', exposure: 'model-facing', inputSchema: workReportSchema, hostOwnedFields: [...commonIdentityFields, 'leaseToken', 'routeEpoch', 'workUnitId'] },
  { name: 'enno_verify_prepare', owner: 'kiokuko-core', exposure: 'host-only', inputSchema: verificationPrepareSchema, hostOwnedFields: [...commonIdentityFields] },
  { name: 'enno_finish', owner: 'kiokuko-core', exposure: 'model-facing', inputSchema: finishSchema, hostOwnedFields: [...commonIdentityFields, 'advisoryRoundDigest', 'advisoryDisposition'] },
  { name: 'enno_meditation_submit', owner: 'kiokuko-core', exposure: 'model-facing', inputSchema: meditationSubmissionSchema, hostOwnedFields: [...commonIdentityFields] },
  { name: 'curator_check', owner: 'kiokuko-core', exposure: 'model-facing', inputSchema: curatorCheckInputSchema, hostOwnedFields: ['cwd', 'workspace'] },
  { name: 'curator_globalize', owner: 'kiokuko-core', exposure: 'host-only', inputSchema: curatorGlobalizeInputSchema, hostOwnedFields: ['workspace', 'entryId', 'expectedRevision', 'confirmed'] },
  { name: 'memory_checkpoint', owner: 'kiokuko-core', exposure: 'model-facing', inputSchema: memoryCheckpointInputSchema, hostOwnedFields: ['cwd', 'runId', 'deliveryId'] },
] as const satisfies readonly ModelToolContract[];
