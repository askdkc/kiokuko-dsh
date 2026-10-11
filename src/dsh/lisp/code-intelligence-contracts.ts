/// <reference path="./code-intelligence-provider.d.ts" preserve="true" />
import { z } from 'zod'
import type { CodeRequestV1, CodeResponseV1 } from '@askdkc/dsh-lsp-server/code-intelligence-contracts'
export type { CodeRequestV1, CodeResponseV1, CodeIntelligenceServiceV1, CodeLeaseV1, CodeHostBindingV1 } from '@askdkc/dsh-lsp-server/code-intelligence-contracts'
export const CODE_METHODS = ['code-capabilities', 'code-open', 'code-release', 'code-outline', 'code-enclosing', 'code-query', 'code-span', 'code-semantic'] as const
const position = z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() }).strict()
const range = z.object({ start: position, end: position }).strict().refine(r => r.end.line > r.start.line || r.end.line === r.start.line && r.end.character >= r.start.character)
const handle = z.string().min(1).max(256)
const limit = z.number().int().min(1).max(200).optional()
export const CodeRequest = z.discriminatedUnion('method', [
  z.object({ method: z.literal('capabilities') }).strict(),
  z.object({ method: z.literal('snapshot.open'), path: z.string().min(1).max(4096) }).strict(),
  z.object({ method: z.literal('snapshot.release'), handle }).strict(),
  z.object({ method: z.literal('structure.outline'), handle, range: range.optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  z.object({ method: z.literal('structure.enclosing'), handle, position, kinds: z.array(z.string().min(1).max(100)).max(30).optional() }).strict(),
  z.object({ method: z.literal('structure.query'), handle, queryId: z.enum(['declarations', 'calls', 'imports']), range: range.optional(), limit }).strict(),
  z.object({ method: z.literal('structure.span'), nodeHandle: handle, maxChars: z.number().int().min(1).max(8000).optional() }).strict(),
  z.object({ method: z.literal('semantic.query'), handle, kind: z.enum(['definition', 'references', 'implementation', 'hover', 'diagnostics', 'completion']), position: position.optional(), limit }).strict()
]).refine(r => r.method !== 'semantic.query' || r.kind === 'diagnostics' || r.position !== undefined)
const response = z.object({ protocol: z.literal('code-intelligence/v1'), status: z.enum(['ok', 'partial', 'unsupported', 'unavailable', 'stale', 'cancelled', 'timeout', 'limit_exceeded']), reason: z.string().min(1).max(128).optional(), sourceKind: z.literal('disk'), freshness: z.enum(['pinned', 'current', 'unknown', 'stale']), snapshotVersion: z.string().min(1).max(256).optional(), truncated: z.boolean(), omitted: z.number().int().nonnegative(), inputBytes: z.number().int().nonnegative().max(2097152).optional(), data: z.unknown().optional() }).strict()
const node = z.object({ handle, kind: z.string().min(1).max(100), name: z.string().max(256).optional(), range }).strict()
const location = z.object({ uri: z.string().max(4096), range }).strict()
const shapes = {
  capabilities: z.object({ version: z.literal(1), capabilities: z.array(z.enum(['snapshots', 'structure', 'semantic'])).max(3), languages: z.array(z.string().max(100)).max(20), queryIds: z.array(z.enum(['declarations','calls','imports'])).max(3), semanticReady: z.boolean(), sourceKinds:z.tuple([z.literal('disk')]),
    languageCapabilities:z.array(z.object({language:z.string().max(100),structure:z.boolean(),semantic:z.array(z.enum(['definition','references','implementation','hover','diagnostics','completion'])).max(6),semanticReady:z.boolean(),reason:z.string().max(128).optional()}).strict()).max(20),
    limits:z.object({documentBytes:z.number().int().positive().max(2097152),captureItems:z.number().int().positive().max(200),outlineItems:z.number().int().positive().max(100),spanChars:z.number().int().positive().max(8000),responseBytes:z.number().int().positive().max(32768),files:z.number().int().positive().max(100),inputBytes:z.number().int().positive().max(16777216),outputBytes:z.number().int().positive().max(65536),calls:z.number().int().positive().max(100),batchMs:z.number().int().positive().max(30000),structureMs:z.number().int().positive().max(2000),semanticMs:z.number().int().positive().max(10000)}).strict() }).strict(),
  'snapshot.open': z.object({ handle, path: z.string().max(4096), language: z.string().max(100), parseErrors: z.boolean() }).strict(),
  'snapshot.release': z.object({ released: z.boolean() }).strict(),
  'structure.outline': z.object({ items: z.array(node).max(100) }).strict(),
  'structure.enclosing': z.object({ items: z.array(node).max(200) }).strict(),
  'structure.query': z.object({ items: z.array(node).max(200), queryId: z.enum(['declarations','calls','imports']) }).strict(),
  'structure.span': z.object({ text: z.string().max(8000), range }).strict()
}
export function validateCodeResponse(input: CodeRequestV1, value: unknown): CodeResponseV1 {
  const result = response.parse(value)
  if (result.status === 'ok' || result.status === 'partial') {
    if (input.method === 'semantic.query') {
      const shape = input.kind === 'hover' ? z.object({ hover: z.object({ contents: z.string().max(16000), range: range.optional() }).strict().nullable() }).strict()
        : input.kind === 'completion' ? z.object({ items: z.array(z.object({ label:z.string().max(1000), detail:z.string().max(4000).optional(), documentation:z.string().max(8000).optional(), kind:z.number().int().optional(), insertText:z.string().max(8000).optional() }).strict()).max(200) }).strict()
        : input.kind === 'diagnostics' ? z.object({ items:z.array(location.extend({ message:z.string().max(8000), severity:z.number().int().min(1).max(4).optional() }).strict()).max(200) }).strict()
        : z.object({ items:z.array(location).max(200) }).strict()
      result.data = shape.parse(result.data)
    } else result.data = shapes[input.method].parse(result.data)
    if (input.method !== 'capabilities' && input.method !== 'snapshot.release' && (!result.snapshotVersion || result.freshness === 'unknown' || result.freshness === 'stale')) throw new Error('invalid snapshot metadata')
  } else if (result.data !== undefined || !result.reason) throw new Error('invalid failure envelope')
  return JSON.parse(JSON.stringify(result)) as CodeResponseV1
}
export function codeOutcome(status: CodeResponseV1['status'], reason: string): CodeResponseV1 {
  return { protocol: 'code-intelligence/v1', status, reason, sourceKind: 'disk', freshness: status === 'stale' ? 'stale' : 'unknown', truncated: false, omitted: 0 }
}
