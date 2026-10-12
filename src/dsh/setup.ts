import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { readRegularFile } from '../config/read-regular-file.js'
import { KiokukoError } from '../errors.js'
import { deploymentParent, publishFile, type DeploymentFile } from './managed-file-deployment.js'
import { planStandardSkills } from './standard-skill-deployment.js'
import { SOUL_ROUTING_ENTRY_CONTRACT } from './standard-skills.js'

const BEGIN = '<!-- BEGIN KIOKUKO-DSH MANAGED BLOCK -->'
const END = '<!-- END KIOKUKO-DSH MANAGED BLOCK -->'
const LEGACY_BEGIN = '<!-- BEGIN KIOKUKO MANAGED BLOCK -->'
const LEGACY_END = '<!-- END KIOKUKO MANAGED BLOCK -->'
// A generic Kiokuko marker alone does not establish DSH ownership.
const LEGACY_DSH_START = /<!-- BEGIN KIOKUKO MANAGED BLOCK -->(?=\r?\n<!-- kiokuko-dsh-template-version: \d+ -->)/u

export const DSH_MANAGED_BLOCK = `${BEGIN}
<!-- kiokuko-dsh-template-version: 2 -->
<!-- Managed by kiokuko-dsh setup on plugin load. Edit outside the markers. -->

## Kiokuko DSH

Apply this entire block only when the current host is DSH and kiokuko-dsh is enabled for this session.
Otherwise ignore every instruction in this block, including Skill routing, tools, planning, memory and completion rules.
The presence of this block, repository files or installed packages does not activate it.
Only kiokuko-dsh may update this block; other plugins and agents must preserve it verbatim.
Do not apply kiokuko or kiokuko-ai instruction blocks as kiokuko-dsh configuration.

${SOUL_ROUTING_ENTRY_CONTRACT}

The host owns request identity, session binding, memory delivery and finalization.
Use its admitted workspace and directive; do not read or modify the SQLite file directly.

Use kioku_read, kioku_write, kioku_edit, kioku_remove, kioku_exec and kioku_result for host-observed development. Project edits, external investigation, PATH commands, bash/zsh, builds/tests and routine Kioku saving need no extra approval. Source/data deletion and durable user database mutations require concrete review; declare destructiveTargets for commands. Generated/temp/disposable artifacts are ordinary development. Lisp and normal tools coexist. Plan, goal, cancellation and execution ownership remain authoritative. Explicit human implementation instructions request Plan exit at the next accepted step; presenting a plan alone does not exit. Bind task_completion checks and relevant source/test/config paths before execution. Collect asynchronous final results. Host receipts distinguish work outcome, verification and saving; model fields such as passed cannot supply proof. Apply recalled candidates only after comparing conditions, provenance and source versions; old verification is not current success. Saving failures do not stop coding and may be retried without replaying edits or commands.

Discover unfamiliar repository filenames with native glob/grep before read; use an exact returned path. Never infer a test filename from a source basename or treat remembered/example paths as current filesystem evidence. Explicit user targets may be read directly; if missing, report that fact and discover relevant alternatives without silently changing the requested target. After a not-found error, do not repeat the unchanged read or assume a sandbox/configuration fault; check current path evidence. Do not create placeholder files or silently substitute another target to hide a missing-file error.

${END}`

/** Replace only a DSH-owned block, preserving every other product's instructions. */
export function renderDshInstructions(existing: string): string {
  const conflict = () => new KiokukoError('CONFLICT', 'AGENTS.md must contain exactly one complete kiokuko-dsh managed block; repair its markers before setup')
  const starts = existing.split(BEGIN).length - 1
  const ends = existing.split(END).length - 1
  const legacyStarts = [...existing.matchAll(new RegExp(LEGACY_DSH_START.source, 'gu'))].map(match => match.index)
  if (legacyStarts.length > 1 || legacyStarts.length && (starts || ends)) throw conflict()
  let start: number, end: number, closing: string
  if (starts || ends) {
    start = existing.indexOf(BEGIN)
    end = existing.indexOf(END)
    if (starts !== 1 || ends !== 1 || end < start) throw conflict()
    closing = END
  } else if (legacyStarts.length === 1) {
    start = legacyStarts[0]!
    end = existing.indexOf(LEGACY_END, start + LEGACY_BEGIN.length)
    const nested = existing.indexOf(LEGACY_BEGIN, start + LEGACY_BEGIN.length)
    if (end < start || nested !== -1 && nested < end) throw conflict()
    closing = LEGACY_END
  } else return existing
  const newline = existing.includes('\r\n') ? '\r\n' : '\n'
  return existing.slice(0, start) + DSH_MANAGED_BLOCK.replaceAll('\n', newline) + existing.slice(end + closing.length)
}

async function planInstructions(workspace: string): Promise<DeploymentFile | undefined> {
  const target = path.join(workspace, 'AGENTS.md')
  const previous = await readRegularFile(target, { containmentRoot: workspace })
  if (previous === undefined || !previous.content.includes(BEGIN) && !previous.content.includes(END)
    && !LEGACY_DSH_START.test(previous.content)) return undefined
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
