import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const targets = Object.freeze({
  'linux:x64': 'x86_64-unknown-linux-musl',
  'linux:arm64': 'aarch64-unknown-linux-musl',
  'darwin:arm64': 'aarch64-apple-darwin',
})
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = message => { throw new Error(`Bundled Rust guardrail: ${message}`) }
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function regularBytes(root, path, maximum, executable = false) {
  if (typeof path !== 'string' || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\'))) fail('invalid asset path')
  let full = root
  const parts = path.split('/')
  for (let index = 0; index <= parts.length; index++) {
    if (index > 0) full = join(full, parts[index - 1])
    let stat
    try { stat = lstatSync(full) } catch (error) { if (error.code === 'ENOENT') fail(`missing artifact ${path}; enrollment unavailable`); throw error }
    if (stat.isSymbolicLink()) fail(`symlink asset is forbidden: ${path}`)
    if (index < parts.length && !stat.isDirectory()) fail(`asset parent must be a directory: ${path}`)
    if (index === parts.length && !stat.isFile()) fail(`artifact must be a regular file: ${path}`)
  }
  const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) fail(`artifact must be a regular file: ${path}`)
    if (stat.size <= 0 || stat.size > maximum) fail(`invalid artifact size: ${path}`)
    if (executable && (stat.mode & 0o111) === 0) fail(`artifact is not executable: ${path}`)
    const bytes = readFileSync(fd)
    if (bytes.length !== stat.size) fail(`artifact size changed while reading: ${path}`)
    return bytes
  } finally { closeSync(fd) }
}
function json(bytes, label) {
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { fail(`malformed ${label}`) }
  if (!record(value)) fail(`malformed ${label}`)
  return value
}
function matches(bytes, expected, label) {
  if (!record(expected) || !Number.isSafeInteger(expected.bytes) || expected.bytes !== bytes.length || !hex(expected.sha256) || digest(bytes) !== expected.sha256) fail(`size/digest integrity mismatch: ${label}`)
}
function boundedOffset(value, maximum, label) {
  if (value > BigInt(maximum)) fail(`${label} exceeds artifact bytes`)
  return Number(value)
}
function executableHeader(bytes, target) {
  const arm = target.startsWith('aarch64-')
  if (target.endsWith('-linux-musl')) {
    if (bytes.length < 64 || !bytes.subarray(0, 7).equals(Buffer.from([0x7f, 69, 76, 70, 2, 1, 1])) || bytes.readUInt16LE(18) !== (arm ? 183 : 62)) fail('ELF64 architecture/header mismatch')
    const type = bytes.readUInt16LE(16), phoff = boundedOffset(bytes.readBigUInt64LE(32), bytes.length, 'ELF header')
    const stride = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56)
    if (![2, 3].includes(type) || bytes.readUInt32LE(20) !== 1 || bytes.readUInt16LE(52) !== 64 || stride !== 56 || !count || phoff < 64 || phoff + count * stride > bytes.length) fail('truncated or unsupported ELF executable layout')
    let executable = false
    for (let offset = phoff; offset < phoff + count * stride; offset += stride) {
      const kind = bytes.readUInt32LE(offset), flags = bytes.readUInt32LE(offset + 4)
      const start = bytes.readBigUInt64LE(offset + 8), size = bytes.readBigUInt64LE(offset + 32), memory = bytes.readBigUInt64LE(offset + 40)
      if (size && (start > BigInt(bytes.length) || start + size > BigInt(bytes.length))) fail('ELF segment exceeds artifact bytes')
      if (kind === 1 && size > memory) fail('ELF load segment size is invalid')
      if (kind === 3) fail('expected static musl ELF without a dynamic interpreter')
      executable ||= kind === 1 && Boolean(flags & 1)
    }
    if (!executable) fail('ELF has no executable load segment')
  } else {
    if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== (arm ? 0x0100000c : 0x01000007)) fail('Mach-O64 architecture/header mismatch')
    const count = bytes.readUInt32LE(16), size = bytes.readUInt32LE(20)
    if (bytes.readUInt32LE(12) !== 2 || !count || size > bytes.length - 32) fail('truncated or non-executable Mach-O layout')
    let offset = 32, executable = false
    for (let index = 0; index < count; index++) {
      if (offset + 8 > 32 + size) fail('truncated Mach-O load command')
      const kind = bytes.readUInt32LE(offset), stride = bytes.readUInt32LE(offset + 4)
      if (stride < 8 || stride % 8 || offset + stride > 32 + size) fail('invalid Mach-O load command size')
      if (kind === 0x19) {
        if (stride < 72) fail('truncated Mach-O64 segment')
        const start = bytes.readBigUInt64LE(offset + 40), length = bytes.readBigUInt64LE(offset + 48)
        if (start + length > BigInt(bytes.length)) fail('Mach-O segment exceeds artifact bytes')
        executable ||= length > 0n && Boolean(bytes.readUInt32LE(offset + 60) & 4)
      }
      offset += stride
    }
    if (offset !== 32 + size || !executable) fail('Mach-O executable segment/layout mismatch')
  }
}
function indexAt(root) {
  const metadata = json(regularBytes(root, 'package.json', 1024 * 1024), 'package metadata')
  if (!record(metadata.guardrail) || metadata.guardrail.manifest !== 'guardrail/manifest.json' || !hex(metadata.guardrail.manifestSha256)) fail('package metadata has no pinned guardrail manifest')
  const bytes = regularBytes(root, metadata.guardrail.manifest, 1024 * 1024)
  if (digest(bytes) !== metadata.guardrail.manifestSha256) fail('package manifest digest integrity mismatch')
  const index = json(bytes, 'guardrail manifest')
  if (index.schema !== 1 || index.package !== 'kiokuko-guardrail' || typeof index.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/u.test(index.version) || !record(index.targets) || !record(index.protocol) || index.protocol.path !== 'guardrail/protocols/coding-routine.lisp') fail('guardrail manifest identity/schema mismatch')
  if (Object.keys(index.targets).length === 0) fail('guardrail manifest declares no bundled targets')
  if (!Array.isArray(index.unavailableTargets) || Object.keys(index.targets).some(target => !Object.values(targets).includes(target)) || index.unavailableTargets.some(target => !Object.values(targets).includes(target) || target in index.targets)) fail('guardrail manifest target declaration mismatch')
  return { index, manifestDigest: digest(bytes) }
}

/** Select already bundled bytes only. This performs no execution, compilation, download, or PATH lookup. */
export function resolveGuardrail(root, options = {}) {
  root = resolve(root)
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch
  const target = targets[`${platform}:${arch}`]
  if (!target) fail(`unsupported host ${platform}/${arch}; no binary fallback`)
  const { index, manifestDigest } = indexAt(root)
  if (!Object.hasOwn(index.targets, target)) fail(`target ${target} unavailable: not bundled; no download or compilation fallback`)
  const entry = index.targets[target]
  if (!record(entry) || entry.platform !== platform || entry.arch !== arch || entry.binary !== `guardrail/${target}/kiokuko-guardrail` || entry.manifest !== `guardrail/${target}/manifest.json` || !hex(entry.manifestSha256)) fail('target manifest identity/path mismatch')
  const releaseBytes = regularBytes(root, entry.manifest, 1024 * 1024)
  if (digest(releaseBytes) !== entry.manifestSha256) fail('target manifest digest integrity mismatch')
  const release = json(releaseBytes, 'target manifest')
  if (release.schema !== 1 || release.package !== index.package || release.target !== target || release.version !== index.version || release.build_inputs?.target !== target || !hex(release.source_sha256)) fail('release manifest identity mismatch')
  const binary = regularBytes(root, entry.binary, 16 * 1024 * 1024, true)
  matches(binary, entry, 'engine'); matches(binary, release.artifacts?.['bin/kiokuko-guardrail'], 'release engine')
  executableHeader(binary, target)
  const protocol = regularBytes(root, index.protocol.path, 256 * 1024)
  matches(protocol, index.protocol, 'protocol'); matches(protocol, release.artifacts?.['protocols/coding-routine.lisp'], 'release protocol')
  return { binary: join(root, entry.binary), protocol: join(root, index.protocol.path), engineDigest: digest(binary), protocolFileDigest: digest(protocol), manifestDigest, version: index.version, target }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const quiet = process.argv[3] === '--quiet'
    if ((process.argv.length !== 3 && !(process.argv.length === 4 && quiet && process.argv[2] === '--verify-bundled')) || !['--verify-bundled', '--check-host'].includes(process.argv[2])) fail('usage: guardrail-artifacts.mjs --verify-bundled [--quiet]|--check-host')
    if (process.argv[2] === '--check-host') console.log(JSON.stringify(resolveGuardrail(root)))
    else {
      const { index } = indexAt(root)
      for (const entry of Object.values(index.targets)) resolveGuardrail(root, { platform: entry.platform, arch: entry.arch })
      if (!quiet) console.log(JSON.stringify({ verifiedTargets: Object.keys(index.targets), unavailableTargets: index.unavailableTargets, nativeExecutionClaim: false, verification: Object.fromEntries(Object.entries(index.targets).map(([target, entry]) => [target, entry.verification])) }))
    }
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
