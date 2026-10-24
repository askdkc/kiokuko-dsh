import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { upstreamRepository } from './stage-dsh-upstream.mjs'

export const upstreamRef = 'refs/heads/master'
export function parseUpstreamResolution(output) {
  const rows = output.trim().split('\n')
  if (rows.length !== 1) throw new Error('Expected exactly one official master revision')
  const [sha, ref, extra] = rows[0].split(/\s+/)
  if (!/^[a-f0-9]{40}$/.test(sha ?? '') || ref !== upstreamRef || extra) throw new Error('Invalid official master revision')
  return sha
}
export function resolveDshUpstream() {
  return parseUpstreamResolution(execFileSync('git', ['ls-remote', upstreamRepository, upstreamRef], { encoding: 'utf8' }))
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const sha = resolveDshUpstream()
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Official DSH master: ${sha}\n`)
  console.log(sha)
}
