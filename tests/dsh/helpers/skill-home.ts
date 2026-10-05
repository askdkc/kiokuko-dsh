import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, mock } from 'node:test'

/** Plugin startup deploys user Skills; tests must never use the developer's real home. */
export function isolateSkillHome(): () => string {
  let directory: string
  let restore: () => void
  before(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'kiokuko-skill-home-'))
    const mocked = mock.method(os, 'homedir', () => directory)
    restore = () => mocked.mock.restore()
  })
  after(async () => {
    restore?.()
    if (directory) await rm(directory, { recursive: true, force: true })
  })
  return () => directory
}

/** Standalone evaluation counterpart; no test lifecycle or real profile writes. */
export async function withIsolatedSkillHome<T>(run: () => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kiokuko-evaluation-home-'))
  const mocked = mock.method(os, 'homedir', () => directory)
  try { return await run() }
  finally { mocked.mock.restore(); await rm(directory, { recursive: true, force: true }) }
}
