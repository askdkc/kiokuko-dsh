import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { valid, validRange } from 'semver'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import type { DshUserQuestions } from '../user-interaction.js'
import { confirm } from './approval.js'
import { fail, type LispOwner } from './contracts.js'
import { checkedBytes, checkedDirectory, sameFile, snapshot, type FileSnapshot } from './files.js'
import { runPackageCommand, type PackageCommand } from './package-manager.js'

const REGISTRY = 'https://registry.npmjs.org'
const LIMIT = 262144
const Name = z.string().max(214).regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u)
const Version = z.string().max(128).refine(value => valid(value) === value, 'An exact canonical version is required.')
const Versions = z.record(Name, Version).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 10)
export const PackageRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('metadata'), name: Name, version: z.union([z.literal('latest'), Version]).default('latest') }).strict(),
  z.object({ kind: z.literal('audit'), versions: Versions }).strict(),
  z.object({ kind: z.literal('update'), versions: Versions, directory: z.string().min(1).max(4096).default('.') }).strict(),
])
export type PackageRequest = z.infer<typeof PackageRequest>
export interface PackageResult { value: unknown; base?: { readSet: FileSnapshot[]; targets: Record<string, FileSnapshot> } }
const names = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'] as const

/** Reject local/git/URL dependencies, hooks, nested overrides and multi-project resolution. */
function registryManifest(original: Record<string, unknown>, versions: Record<string, string>): Record<string, unknown> {
  if (original.workspaces) fail('PACKAGES_WORKSPACES', 'Only one root project is supported; workspace projects require separate operations.')
  const result: Record<string, unknown> = {}
  for (const key of ['name', 'version', 'engines', 'peerDependenciesMeta']) if (original[key] !== undefined) result[key] = original[key]
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides']) {
    if (original[key] === undefined && key !== 'overrides') continue
    const map = z.record(Name, z.string().max(256)).parse(original[key] ?? {})
    if (Object.values(map).some(value => !validRange(value))) fail('PACKAGES_SOURCE_REFUSED', 'Only registry semver dependencies and flat overrides are supported.')
    result[key] = key === 'overrides' ? { ...map, ...versions } : map
  }
  // No scripts, bin, packageManager, pnpm hooks or repository configuration cross the broker boundary.
  return result
}

function registryLock(value: unknown): void {
  if (Array.isArray(value)) { for (const entry of value) registryLock(entry); return }
  if (!value || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'link' && entry === true) fail('PACKAGES_SOURCE_REFUSED', 'Linked lockfile entries are not supported.')
    if (typeof entry === 'string') {
      if (/^(?:file:|link:|git[+:]|github:|workspace:)/u.test(entry)) fail('PACKAGES_SOURCE_REFUSED', 'Local and Git lockfile sources are not supported.')
      if (key === 'resolved' || key === 'tarball') {
        let url: URL
        try { url = new URL(entry) } catch { return fail('PACKAGES_SOURCE_REFUSED', 'Lockfile sources must be public registry URLs.') }
        if (url.origin !== REGISTRY || url.username || url.password || url.hash) fail('PACKAGES_SOURCE_REFUSED', 'Only public npm registry lockfile URLs are supported.')
      }
    } else registryLock(entry)
  }
}

async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void pending.catch(() => {}); throw signal.reason }
  let abort: (() => void) | undefined
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })])
  } finally { if (abort) signal.removeEventListener('abort', abort) }
}

async function registryJson(fetcher: typeof fetch, path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(30000)])
  let response: Response
  try {
    response = await abortable(fetcher(`${REGISTRY}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', credentials: 'omit',
      signal: combined, headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), combined)
    combined.throwIfAborted()
    if (!response.ok || response.redirected) fail('PACKAGES_HTTP_FAILED', 'Registry request failed; no retry was made.')
    const length = response.headers.get('content-length')
    if (length && Number(length) > LIMIT) fail('PACKAGES_RESPONSE_LIMIT', 'Registry response exceeds 256 KiB.')
    const reader = response.body?.getReader()
    if (!reader) fail('PACKAGES_RESPONSE_INVALID', 'Registry returned no JSON body.')
    const chunks: Uint8Array[] = []; let bytes = 0
    try {
      for (;;) {
        const part = await abortable(reader.read(), combined); combined.throwIfAborted()
        if (part.done) break
        bytes += part.value.length
        if (bytes > LIMIT) fail('PACKAGES_RESPONSE_LIMIT', 'Registry response exceeds 256 KiB.')
        chunks.push(part.value)
      }
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
    combined.throwIfAborted()
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    if (signal.aborted) throw signal.reason
    if (error && typeof error === 'object' && 'code' in error && String(error.code).startsWith('PACKAGES_')) throw error
    return fail('PACKAGES_NETWORK_FAILED', 'Registry response failed, was invalid or timed out; no retry was made.')
  }
}

/** Explicit approval for every network operation. Host credentials/configuration never enter worker or child. */
export function createLispPackageAdapter(questions?: DshUserQuestions, fetcher: typeof fetch = fetch, command: PackageCommand = runPackageCommand) {
  return async (owner: LispOwner, input: unknown, signal: AbortSignal): Promise<PackageResult> => {
    const request = PackageRequest.parse(input)
    const before = request.kind === 'update' ? await capture(owner, request.directory) : undefined
    const label = 'Run this package operation'
    const approval = await confirm(questions, owner.agentId, { id: `lisp-packages-${randomUUID()}`, header: 'Lisp · Package operation',
      question: `Allow ${request.kind} via the public npm registry?`,
      detail: `Registry: ${REGISTRY} (no authentication)\nRequest: ${JSON.stringify(request)}\n${request.kind === 'metadata' ? 'Sends only the package name/version.' : request.kind === 'audit' ? 'Sends only the selected package names/versions to the bulk advisory endpoint.' : 'Runs installed npm/pnpm in private OS-protected scratch with network access, clean configuration/environment, no lifecycle scripts or hooks. Only captured root manifests/locks are copied. No repository writes or dependency installation; generated files still require proposal approval.'}\nTimeout: HTTP 30 s; each fixed package-manager command 90 s. No retries.`,
      options: [{ label: 'Do not run' }, { label }], intent: { kind: 'plan-review', approve: label },
    }, signal)
    if (!approval.approved) return { value: { state: 'NOT_APPLIED', reason: approval.reason } }
    signal.throwIfAborted()
    if (request.kind === 'metadata') {
      const value = await registryJson(fetcher, `/${encodeURIComponent(request.name)}/${encodeURIComponent(request.version)}`, signal)
      const metadata = z.object({ name: Name, version: Version, dist: z.object({ integrity: z.string().max(256), tarball: z.string().max(4096) }),
        dependencies: z.record(z.string(), z.string()).optional(), optionalDependencies: z.record(z.string(), z.string()).optional(), engines: z.record(z.string(), z.string()).optional() }).parse(value)
      if (metadata.name !== request.name || (request.version !== 'latest' && metadata.version !== request.version)) fail('PACKAGES_RESPONSE_INVALID', 'Registry package identity does not match.')
      const url = new URL(metadata.dist.tarball)
      if (url.origin !== REGISTRY || url.username || url.password) fail('PACKAGES_RESPONSE_INVALID', 'Registry tarball identity does not match.')
      return { value: { state: 'SUCCEEDED', source: REGISTRY, package: metadata } }
    }
    if (request.kind === 'audit') {
      const body = Object.fromEntries(Object.entries(request.versions).map(([name, version]) => [name, [version]]))
      const result = z.record(Name, z.array(z.object({ id: z.number(), name: Name, title: z.string(), url: z.string(), severity: z.string(), vulnerable_versions: z.string() }).passthrough()).max(100))
        .parse(await registryJson(fetcher, '/-/npm/v1/security/advisories/bulk', signal, body))
      if (Object.keys(result).some(name => !Object.hasOwn(body, name))) fail('PACKAGES_RESPONSE_INVALID', 'Advisory package identity does not match.')
      return { value: { state: 'SUCCEEDED', source: REGISTRY, audited: request.versions, advisories: result } }
    }
    return generate(owner, request, before!, command, signal)
  }
}

async function capture(owner: LispOwner, directory: string) {
  const root = await checkedDirectory(owner.root, directory)
  const files = await Promise.all(names.map(async name => {
    const path = directory === '.' ? name : `${directory}/${name}`
    const before = await snapshot(owner.root, path, [])
    if ((before.size ?? 0) > LIMIT) fail('PACKAGES_FILE_LIMIT', 'Root package files must fit 256 KiB each.')
    return { name, path, before, text: before.exists ? (await checkedBytes(before)).toString('utf8') : undefined }
  }))
  if (!files[0]!.text || (!files[1]!.text && !files[2]!.text)) fail('PACKAGES_INPUT_MISSING', 'package.json and at least one existing lockfile are required.')
  return { root, files }
}

async function generate(owner: LispOwner, request: Extract<PackageRequest, { kind: 'update' }>, captured: Awaited<ReturnType<typeof capture>>, command: PackageCommand, signal: AbortSignal): Promise<PackageResult> {
  const original = z.record(z.string(), z.unknown()).parse(JSON.parse(captured.files[0]!.text!))
  const manifest = registryManifest(original, request.versions)
  const workspace = captured.files[3]!.text ? parseDocument(captured.files[3]!.text) : undefined
  if (workspace?.errors.length || workspace?.get('packages')) fail('PACKAGES_WORKSPACES', 'Invalid or multi-project pnpm workspace is not supported.')
  const overrides = z.object({ overrides: z.record(Name, z.string()).default({}) }).passthrough().parse(workspace?.toJS() ?? {}).overrides
  const pnpmManifest = registryManifest({ ...original, overrides: { ...(manifest.overrides as object), ...overrides } }, request.versions)
  for (const file of captured.files.slice(1, 3)) if (file.text) {
    const value = file.name.endsWith('.json') ? JSON.parse(file.text) : parseDocument(file.text).toJS()
    registryLock(value)
  }
  const unchanged = async () => {
    if (JSON.stringify(captured.root) !== JSON.stringify(await checkedDirectory(owner.root, request.directory))) fail('PACKAGES_BASE_CHANGED', 'Project directory changed.')
    for (const file of captured.files) if (!sameFile(file.before, await snapshot(owner.root, file.path, []))) fail('PACKAGES_BASE_CHANGED', 'A captured package file changed; no generated proposals are returned.')
  }
  await unchanged()
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kiokuko-packages-')))
  try {
    await writeFile(join(directory, '.global-npmrc'), '', { mode: 0o600 })
    await writeFile(join(directory, '.npmrc'), `registry=${REGISTRY}\nignore-scripts=true\naudit=false\nfund=false\nmanage-package-manager-versions=false\n`, { mode: 0o600 })
    const files: Array<{ path: string; content: string }> = []
    const managers: Record<string, string> = {}
    for (const [manager, name, model] of [['npm', 'package-lock.json', manifest], ['pnpm', 'pnpm-lock.yaml', pnpmManifest]] as const) {
      const input = captured.files.find(file => file.name === name)!
      if (!input.text) continue
      // Each manager gets the same explicit overrides, never scripts or original configuration.
      await writeFile(join(directory, 'package.json'), JSON.stringify(model, null, 2))
      await writeFile(join(directory, name), input.text)
      if (manager === 'pnpm') await writeFile(join(directory, 'pnpm-workspace.yaml'), `overrides:\n${Object.entries(model.overrides as Record<string, string>).map(([key, version]) => `  '${key}': '${version}'`).join('\n')}\n`)
      const version = await command(manager, ['--version'], directory, signal)
      if (version.code !== 0 || !valid(version.stdout.trim())) fail('PACKAGES_COMMAND_FAILED', 'Could not identify installed package manager.')
      managers[manager] = version.stdout.trim()
      const args = manager === 'npm'
        ? ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', `--registry=${REGISTRY}`]
        : ['install', '--lockfile-only', '--ignore-scripts', '--ignore-pnpmfile', '--config.manage-package-manager-versions=false', '--config.package-manager-strict=false', `--registry=${REGISTRY}`]
      const result = await command(manager, args, directory, signal)
      if (result.code !== 0) fail('PACKAGES_COMMAND_FAILED', `${manager} lockfile generation failed (exit ${result.code}); no proposals returned.`)
      signal.throwIfAborted()
      const output = await snapshot(directory, name, [])
      if (!output.exists || (output.size ?? 0) > LIMIT) fail('PACKAGES_FILE_LIMIT', 'Generated lockfile is missing or exceeds 256 KiB.')
      const content = (await checkedBytes(output)).toString('utf8')
      registryLock(name.endsWith('.json') ? JSON.parse(content) : parseDocument(content).toJS())
      files.push({ path: input.path, content })
    }
    const updated = { ...original, overrides: { ...(manifest.overrides as object) } }
    files.unshift({ path: captured.files[0]!.path, content: `${JSON.stringify(updated, null, 2)}\n` })
    if (workspace) {
      for (const [name, version] of Object.entries(request.versions)) workspace.setIn(['overrides', name], version)
      files.push({ path: captured.files[3]!.path, content: workspace.toString() })
    } else if (captured.files[2]!.text) files.push({ path: captured.files[3]!.path, content: `overrides:\n${Object.entries(pnpmManifest.overrides as Record<string, string>).map(([key, version]) => `  '${key}': '${version}'`).join('\n')}\n` })
    await unchanged(); signal.throwIfAborted()
    if (Buffer.byteLength(JSON.stringify(files)) > 750000) fail('PACKAGES_FILE_LIMIT', 'Generated package files exceed the bounded Lisp frame.')
    return { value: { state: 'SUCCEEDED', generatedOnly: true, managers, versions: request.versions, files },
      base: { readSet: captured.files.map(file => file.before), targets: Object.fromEntries(captured.files.map(file => [file.path, file.before])) } }
  } finally { await rm(directory, { recursive: true, force: true }) }
}
