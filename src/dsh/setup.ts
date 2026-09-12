import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { readRegularFile } from '../config/read-regular-file.js'
import { KiokukoError } from '../errors.js'
import { deploymentParent, publishFile, type DeploymentFile } from './managed-file-deployment.js'
import { planStandardSkills } from './standard-skill-deployment.js'
import { SOUL_ROUTING_ENTRY_CONTRACT } from './standard-skills.js'

const BEGIN = '<!-- BEGIN KIOKUKO MANAGED BLOCK -->'
const END = '<!-- END KIOKUKO MANAGED BLOCK -->'

export const DSH_MANAGED_BLOCK = `${BEGIN}
<!-- kiokuko-dsh-template-version: 1 -->
<!-- Managed by kiokuko-dsh setup on plugin load. Edit outside the markers. -->

## Kiokuko DSH

These instructions apply to requests running in DSH with kiokuko-dsh enabled.
Outside DSH, this block does not require unavailable host operations or tools.

${SOUL_ROUTING_ENTRY_CONTRACT}

The host owns request identity, session binding, memory delivery and finalization.
Use its admitted workspace and directive; do not read or modify the SQLite file directly.

${END}`

/** Replace only an existing, unambiguous managed block. Never add project files. */
export function renderDshInstructions(existing: string): string {
  const starts = existing.split(BEGIN).length - 1
  const ends = existing.split(END).length - 1
  if (starts === 0 && ends === 0) return existing
  const start = existing.indexOf(BEGIN)
  const end = existing.indexOf(END)
  if (starts !== 1 || ends !== 1 || end < start) {
    throw new KiokukoError('CONFLICT', 'AGENTS.md must contain exactly one complete Kiokuko managed block; repair its markers before setup')
  }
  const newline = existing.includes('\r\n') ? '\r\n' : '\n'
  return existing.slice(0, start) + DSH_MANAGED_BLOCK.replaceAll('\n', newline) + existing.slice(end + END.length)
}

async function planInstructions(workspace: string): Promise<DeploymentFile | undefined> {
  const target = path.join(workspace, 'AGENTS.md')
  const previous = await readRegularFile(target, { containmentRoot: workspace })
  if (previous === undefined || !previous.content.includes(BEGIN) && !previous.content.includes(END)) return undefined
  const content = renderDshInstructions(previous.content)
  if (content !== previous.content) await deploymentParent(workspace, target, false)
  return { target, previous, content }
}

/** Preflight both destinations before writing. A read-only check reports the same plan. */
export async function setupDsh(options: { homeDirectory?: string; cwd?: string; check?: boolean } = {}) {
  const workspace = await realpath(options.cwd ?? process.cwd())
  const skills = await planStandardSkills(options.homeDirectory)
  const instructions = await planInstructions(workspace)
  const result = {
    current: true,
    skills: { directory: skills.directory, created: 0, updated: 0, unchanged: 0 },
    instructions: { path: path.join(workspace, 'AGENTS.md'), status: instructions ? 'unchanged' : 'unmanaged-or-absent' },
  }
  for (const file of skills.files) {
    const status = file.previous?.content === file.content ? 'unchanged'
      : options.check ? file.previous === undefined ? 'created' : 'updated'
        : await publishFile(skills.home, file)
    result.skills[status]++
  }
  if (instructions && instructions.content !== instructions.previous?.content) {
    result.instructions.status = options.check ? 'update-needed' : await publishFile(workspace, instructions)
  }
  result.current = !options.check || result.skills.created + result.skills.updated === 0 && result.instructions.status !== 'update-needed'
  return result
}

export async function setupDshOnLoad(): Promise<void> {
  try {
    const result = await setupDsh()
    if (result.skills.created || result.skills.updated || result.instructions.status === 'updated') {
      console.info(`[kiokuko-dsh] [info] Setup complete: Skills ${result.skills.created} created, ${result.skills.updated} updated (${result.skills.directory}); AGENTS.md ${result.instructions.status} (${result.instructions.path}). Reload existing sessions to refresh their instructions.`)
    }
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN'
    console.warn(`[kiokuko-dsh] [warn] Setup synchronization failed (${code}); deployed Skills or AGENTS.md may be stale. ${error instanceof Error ? error.message : 'Unknown setup error'}. Run the bundled scripts/setup-dsh.mjs for this workspace after resolving the conflict. Bundled DSH Skills remain available.`)
  }
}
