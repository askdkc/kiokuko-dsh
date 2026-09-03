import * as z from 'zod/v4';
import { memoryCheckpointInputSchema } from '../memory/checkpoint-contract.js';
import { absoluteCwdSchema } from '../repository/cwd-schema.js';
import {
  finishSchema,
  idealSubmissionSchema,
  meditationSubmissionSchema,
  planSubmissionSchema,
  workReportSchema,
} from '../enno-oduno/schemas.js';

export const MODEL_TOOL_OPERATION_NAMES = [
  'enno_plan_submit',
  'enno_ideal_submit',
  'enno_work_report',
  'enno_finish',
  'enno_meditation_submit',
  'curator_check',
  'memory_checkpoint',
] as const;

export type ModelToolOperationName = (typeof MODEL_TOOL_OPERATION_NAMES)[number];

export type ModelToolOwner = 'kiokuko-core';
export type ModelToolExposure = 'model-facing';

function canonicalIdentity(maximum: number, label: string) {
  return z.string().min(1).max(maximum).refine(
    (value) => value.trim() === value && !/\p{Cc}/u.test(value),
    { message: `${label} must be a canonical bounded identity` },
  );
}

const workspaceId = canonicalIdentity(256, 'workspace');
export const curatorCheckInputSchema = z.object({
  cwd: absoluteCwdSchema.optional().describe('Absolute current working directory; defaults to the DSH process cwd'),
  workspace: workspaceId.optional().describe('Exact project workspace; normally omit and resolve from cwd'),
  limit: z.number().int().min(1).max(20).default(5),
  includeUnready: z.boolean().default(false).describe('Include lower-evidence candidates for manual inspection; automated permission prompts should leave this false'),
}).strict();

export interface ModelToolContract {
  readonly name: ModelToolOperationName;
  readonly owner: ModelToolOwner;
  readonly exposure: ModelToolExposure;
  readonly inputSchema: z.ZodType;
  readonly hostOwnedFields: readonly string[];
}

const commonIdentityFields = ['runId', 'workspace', 'orchestrationId', 'resumeToken', 'expectedRevision', 'idempotencyKey'] as const;

export const MODEL_TOOL_CONTRACTS = [
  { name: 'enno_plan_submit', owner: 'kiokuko-core', exposure: 'model-facing', inputSchema: planSubmissionSchema, hostOwnedFields: [...commonIdentityFields, 'advisoryRoundDigest', 'recoveryAction', 'capabilities'] },
  { name: 'enno_ideal_submit', owner: 'kiokuko-core', exposure: 'model-facing', inputSchema: idealSubmissionSchema, hostOwnedFields: [...commonIdentityFields, 'advisoryRoundDigest'] },
  { name: 'enno_work_report', owner: 'kiokuko-core', exposure: 'model-facing', inputSchema: workReportSchema, hostOwnedFields: [...commonIdentityFields, 'leaseToken', 'routeEpoch', 'workUnitId'] },
  { name: 'enno_finish', owner: 'kiokuko-core', exposure: 'model-facing', inputSchema: finishSchema, hostOwnedFields: [...commonIdentityFields, 'advisoryRoundDigest'] },
  { name: 'enno_meditation_submit', owner: 'kiokuko-core', exposure: 'model-facing', inputSchema: meditationSubmissionSchema, hostOwnedFields: [...commonIdentityFields] },
  { name: 'curator_check', owner: 'kiokuko-core', exposure: 'model-facing', inputSchema: curatorCheckInputSchema, hostOwnedFields: ['cwd', 'workspace'] },
  { name: 'memory_checkpoint', owner: 'kiokuko-core', exposure: 'model-facing', inputSchema: memoryCheckpointInputSchema, hostOwnedFields: ['cwd', 'runId', 'deliveryId'] },
] as const satisfies readonly ModelToolContract[];
