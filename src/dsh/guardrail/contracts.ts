import * as z from 'zod/v4'
import type { TaskLease } from '../task-state.js'
const relative = z.string().min(1).max(512).refine(value => !value.startsWith('/') && !value.includes('\\') && !value.split('/').some(part => !part || part === '.' || part === '..') && !/[\p{Cc}\p{Cf}]/u.test(value))
export const ProtocolRecipeSchema = z.object({ kind: z.literal('bounded-tdd-v1'), unitId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u), implementationPaths: z.array(relative).min(1).max(32), testPaths: z.array(relative).min(1).max(32) }).strict().superRefine((value, ctx) => {
  const paths = [...value.implementationPaths, ...value.testPaths]
  if (new Set(paths).size !== paths.length) ctx.addIssue({code:'custom',message:'Implementation and test paths must be unique and disjoint'})
})
export type ProtocolRecipe = z.infer<typeof ProtocolRecipeSchema>
export type Manifest = Record<string, string | null>
export const PROTOCOL_CAPABILITIES = Object.freeze({validation:'bounded-cl-v1',ownedEffects:'lease-transactional-v1',nodeTests:'process-only',lispEffects:'protected-required',rollback:false,heapRestoration:false} as const)
export const PROTOCOL_ISSUER = 'kiokuko-dsh:owned-execution:v1' as const
export interface ProtocolObservation {
  schema: 1; operationId: string; runtimeDigest: string; environmentDigest: string; complete: boolean; tests: number; passed: number; failed: number; assertionFailures: number; otherFailures: number; skipped: number; todo: number; cancelled: number; explicit: number
}
export interface ProtocolReceipt {
  issuer: typeof PROTOCOL_ISSUER; id: string; task: TaskLease; recipeId: string; generation: number;
  sourceDigest: string; testDigest: string; commandDigest: string; runtimeDigest: string;
  environmentDigest: string; ownedReceiptDigest: string; observationDigest: string; outputDigest: string; outcome: 'assertion-failure' | 'passed' | 'setup-error'; assertions: number; exit: number; digest: string
}
export interface ProtocolState {
  schema: 1; recipe: ProtocolRecipe; recipeId: string; scopeVersion: number; generation: number; lease: TaskLease;
  criterionId: string; methodDigest: string; runtimeDigest: string; command: string; cwd: string; sourcePaths: string[];
  phase: 'write-tests' | 'verify-red' | 'implement' | 'verify-green' | 'report' | 'blocked';
  source: Manifest; tests: Manifest; baselineTests: Manifest; edits: string[];
  red?: ProtocolReceipt; green?: ProtocolReceipt; consumed: string[];
  pending?: { id: string; kind: 'file' | 'test'; requestDigest: string; path?: string; phase: ProtocolState['phase'] };
  reason?: string;
}
