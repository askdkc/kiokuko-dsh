import * as z from 'zod/v4';
import { memoryCheckpointInputSchema } from '../memory/checkpoint-contract.js';
import { absoluteCwdSchema } from '../repository/cwd-schema.js';
import { type ModelToolOperationName } from './names.js';
export { MODEL_TOOL_OPERATION_NAMES, type ModelToolOperationName } from './names.js';

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


export const MODEL_TOOL_CONTRACTS = [
  { name: 'curator_check', owner: 'kiokuko-core', exposure: 'model-facing', inputSchema: curatorCheckInputSchema, hostOwnedFields: ['cwd', 'workspace'] },
  { name: 'memory_checkpoint', owner: 'kiokuko-core', exposure: 'model-facing', inputSchema: memoryCheckpointInputSchema, hostOwnedFields: ['cwd', 'runId', 'deliveryId'] },
] as const satisfies readonly ModelToolContract[];
