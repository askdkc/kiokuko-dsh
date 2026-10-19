// Native artifact transport is separate from runtime availability. No cross-build is native proof.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const nativeTargets = Object.freeze({
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-gnu', 'linux-x64': 'x86_64-unknown-linux-gnu',
})
export const sha256 = value => createHash('sha256').update(value).digest('hex')
export async function sourceDigest(root) {
  return sha256(Buffer.concat(await Promise.all(['Cargo.toml', 'src/main.rs', 'src/digest.rs'].map(file => readFile(join(root, 'crates/micro-judge', file))))))
}
export function acceptanceSummary(tap) {
  const counts = Object.fromEntries(['tests','pass','fail','cancelled','skipped','todo'].map(key => {
    const values = [...tap.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))]
    assert.equal(values.length, 1, `Missing or ambiguous native TAP summary: ${key}`)
    return [key, Number(values[0][1])]
  }))
  assert.ok(counts.tests >= 18, 'Native acceptance suite must include real executable/oracle cases')
  assert.equal(counts.pass, counts.tests)
  for (const key of ['fail','cancelled','skipped','todo']) assert.equal(counts[key], 0, `Native acceptance ${key}`)
  for (const name of ['actual Rust agrees with an independent exhaustive oracle on 200 deterministic small problems', 'actual Rust MRV 8 queens has 92 solutions', 'missing or unsupported binary is explicit unavailable, never an allow']) assert.ok(tap.includes(name), `Missing mandatory case: ${name}`)
  return counts
}
export async function regular(path, maximum = 8000000) {
  const info = await lstat(path)
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size < maximum, `Invalid artifact file: ${path}`)
  return readFile(path)
}
export async function validateNativeArtifact(root, entry, expectedSource) {
  assert.deepEqual(Object.keys(entry).sort(), ['arch','bytes','compiler','file','nativeVerified','platform','sha256','sourceDigest'])
  const key = `${entry.platform}-${entry.arch}`
  assert.ok(Object.hasOwn(nativeTargets, key), `Unsupported native target: ${key}`)
  assert.equal(entry.file, `${key}/kiokuko-micro-judge`)
  for (const folder of [root, join(root,key)]) {
    const info = await lstat(folder); assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Artifact directories cannot be symlinks')
  }
  assert.equal(entry.sourceDigest, expectedSource, 'Native artifact has stale source')
  assert.equal(entry.nativeVerified, true)
  const binary = await regular(join(root,entry.file))
  assert.equal(binary.length, entry.bytes); assert.equal(sha256(binary), entry.sha256)
  if (entry.platform === 'linux') {
    assert.equal(binary.subarray(0,4).toString('hex'), '7f454c46')
    assert.equal(binary[4], 2); assert.equal(binary[5], 1)
    assert.equal(binary.readUInt16LE(18), entry.arch === 'arm64' ? 183 : 62)
  } else {
    assert.equal(binary.subarray(0,4).toString('hex'), 'cffaedfe')
    assert.equal(binary.readUInt32LE(4), entry.arch === 'arm64' ? 0x100000c : 0x1000007)
  }
  const receipt = JSON.parse(await regular(join(root,`native-verification-${key}.json`)))
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.target, nativeTargets[key])
  assert.equal(receipt.platform, entry.platform); assert.equal(receipt.arch, entry.arch)
  assert.equal(receipt.binarySha256, entry.sha256); assert.equal(receipt.sourceDigest, expectedSource)
  assert.equal(receipt.compiler, entry.compiler); assert.match(receipt.compiler, /^rustc 1\.85\.0 /)
  assert.equal(receipt.exitCode, 0); assert.equal(receipt.log, `native-acceptance-${key}.tap`)
  const tap = await regular(join(root,receipt.log))
  assert.equal(sha256(tap), receipt.logSha256)
  assert.deepEqual(acceptanceSummary(tap.toString()), receipt.summary)
  return { key, binary, receipt, tap }
}
