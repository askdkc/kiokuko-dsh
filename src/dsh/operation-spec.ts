import path from 'node:path'
import * as z from 'zod/v4'
import { canonicalContentHash } from '../serialization/validate.js'

const relativePath = z.string().min(1).max(4096).refine(value =>
  !path.isAbsolute(value) && !value.split(/[\\/]/u).includes('..') && !/[\p{Cc}\p{Cf}]/u.test(value),
  'Expected a repository-relative path without parent traversal')

const base = {
  adapterVersion: z.literal(1),
  directory: relativePath.default('.'),
  timeoutMs: z.number().int().min(100).max(600_000).default(120_000),
}

/** Stable host contract. Display commands are adapter output, never identity. */
export const OperationSpecSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('test'),
    adapter: z.enum(['node-test', 'vitest']),
    ...base,
    files: z.array(relativePath).min(1).max(100),
    namePattern: z.string().min(1).max(4096).optional(),
    isolation: z.enum(['default', 'none']).default('default'),
    configLoader: z.enum(['native', 'runner', 'bundle']).optional(),
  }).strict().superRefine((value, ctx) => {
    if (value.adapter === 'node-test' && value.configLoader)
      ctx.addIssue({ code: 'custom', path: ['configLoader'], message: 'configLoader is only valid for Vitest' })
    if (value.adapter === 'vitest' && value.isolation !== 'default')
      ctx.addIssue({ code: 'custom', path: ['isolation'], message: 'isolation is only valid for Node test' })
  }),
  z.object({
    kind: z.literal('package-script'),
    adapter: z.literal('npm-script'),
    ...base,
    script: z.string().min(1).max(256).regex(/^(?:build|typecheck|test(?::[^\s]+)?)$/u),
    arguments: z.array(z.string().max(4096)).max(64).default([]),
  }).strict(),
])

export type OperationSpec = z.infer<typeof OperationSpecSchema>

export function operationSpecDigest(spec: OperationSpec): string {
  return canonicalContentHash(OperationSpecSchema.parse(spec))
}

export function operationDirectory(spec: OperationSpec): string {
  return OperationSpecSchema.parse(spec).directory
}

export function operationCommand(spec: OperationSpec): { program: string; argv: string[] } {
  const parsed = OperationSpecSchema.parse(spec)
  if (parsed.kind === 'package-script')
    return { program: 'npm', argv: ['run', parsed.script, ...(parsed.arguments.length ? ['--', ...parsed.arguments] : [])] }
  const pattern = parsed.namePattern
    ? [parsed.adapter === 'node-test' ? `--test-name-pattern=${parsed.namePattern}` : `--testNamePattern=${parsed.namePattern}`]
    : []
  if (parsed.adapter === 'node-test') return { program: 'node', argv: [
    '--test', '--test-reporter=tap', ...(parsed.isolation === 'none' ? ['--experimental-test-isolation=none'] : []),
    ...pattern, ...parsed.files,
  ] }
  return { program: './node_modules/.bin/vitest', argv: [
    'run', '--reporter=json', '--includeTaskLocation',
    ...(parsed.configLoader ? ['--configLoader', parsed.configLoader] : []), ...pattern, ...parsed.files,
  ] }
}
