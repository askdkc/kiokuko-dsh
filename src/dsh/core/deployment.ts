import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, parse } from 'node:path'
import { readRegularFile } from '../../config/read-regular-file.js'
import { deploymentParent, publishFile, type DeploymentFile } from '../managed-file-deployment.js'
import { renderStandardSkillFile } from '../standard-skills.js'
import type { ModuleResource } from './modules.js'

/** Selected managed resources only; omitted and user-owned resources are never deleted. */
export async function synchronizeConfiguredSkills(resources: readonly ModuleResource[], homeDirectory = homedir()): Promise<{ created: number; updated: number; unchanged: number }> {
  if (!isAbsolute(homeDirectory) || homeDirectory.includes('\0') || resolve(homeDirectory) === parse(homeDirectory).root) throw new Error('Skill deployment requires an absolute user home')
  const home = await realpath(homeDirectory), files: DeploymentFile[] = [], seen = new Set<string>()
  // Validate and preflight the entire selected manifest before touching any target.
  for (const resource of resources) {
    const identity = `${resource.name}/${resource.relativePath}`
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(resource.name) || !/^(SKILL\.md|references\/[a-z0-9-]+\.md)$/.test(resource.relativePath) || seen.has(identity)) throw new Error('Invalid Skill deployment manifest')
    seen.add(identity)
    const content = await resource.load(), managedMarker = `<!-- KIOKUKO MANAGED STANDARD SKILL: ${resource.name} -->`
    if (Buffer.byteLength(content) > 262_144 || content.split(managedMarker).length !== 2) throw new Error(`Invalid Skill ownership: ${identity}`)
    const directoryName = resource.name === 'natural-japanese-output' ? 'japanese-translation-for-oss-models' : resource.name
    const target = join(home, '.agents/skills', directoryName, resource.relativePath)
    await deploymentParent(home, target, false)
    const previous = await readRegularFile(target, { containmentRoot: home })
    const rendered = renderStandardSkillFile(previous?.content, { skillName: resource.name, managedMarker, relativePath: resource.relativePath, content }, target)
    files.push({ target, previous, content: rendered.content })
  }
  const result = { created: 0, updated: 0, unchanged: 0 }
  for (const file of files) result[file.previous?.content === file.content ? 'unchanged' : await publishFile(home, file)]++
  return result
}
