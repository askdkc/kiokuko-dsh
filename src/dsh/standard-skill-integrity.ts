import { createHash } from 'node:crypto'
import path from 'node:path'
import { isMap, isPair, isScalar, parseDocument } from 'yaml'
import {
  loadBundledStandardSkillFiles,
  STANDARD_SKILL_MANIFESTS,
  type BundledStandardSkillFile,
} from './standard-skills.js'
import { KiokukoError } from '../errors.js'

export interface StandardSkillParity {
  readonly skills: readonly string[]
  readonly files: readonly BundledStandardSkillFile[]
  readonly markdownFileCount: number
  readonly referenceFileCount: number
  readonly contentDigest: string
}

export interface StandardSkillFrontmatter {
  readonly name: string
  readonly description: string | null
  readonly disableModelInvocation: boolean
}

function markerCount(content: string, marker: string): number {
  return content.split(marker).length - 1
}

function localLinkTargets(content: string): string[] {
  const targets: string[] = []
  for (const match of content.matchAll(/\]\(([^)\s]+)(?:#[^)\s]*)?\)/gu)) {
    const target = match[1]
    if (target === undefined || target.startsWith('#') || /^[a-z][a-z\d+.-]*:/iu.test(target) || target.startsWith('//')) continue
    targets.push(target.split(/[?#]/u, 1)[0] ?? target)
  }
  return targets
}

function validateLinks(file: BundledStandardSkillFile, paths: ReadonlySet<string>): void {
  for (const target of localLinkTargets(file.content)) {
    const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(file.relativePath), target))
    if (normalized.startsWith('../') || !paths.has(normalized)) {
      throw new KiokukoError('INTEGRITY_ERROR', `Bundled standard skill link is unavailable: ${file.skillName}/${file.relativePath} -> ${target}`)
    }
  }
}

function contentDigest(files: readonly BundledStandardSkillFile[]): string {
  const rows = [...files]
    .sort((left, right) => `${left.skillName}/${left.relativePath}`.localeCompare(`${right.skillName}/${right.relativePath}`))
    .map((file) => `${file.skillName}\u0000${file.relativePath}\u0000${createHash('sha256').update(file.content, 'utf8').digest('hex')}\n`)
    .join('')
  return createHash('sha256').update(rows, 'utf8').digest('hex')
}

function parseStandardSkillFrontmatter(content: string): StandardSkillFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content)
  if (!match) throw new KiokukoError('INTEGRITY_ERROR', 'Bundled standard skill frontmatter is unavailable')
  const document = parseDocument(match[1]!, { schema: 'core', strict: true, uniqueKeys: true })
  if (document.errors.length > 0 || document.warnings.length > 0 || !isMap(document.contents)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Bundled standard skill frontmatter is invalid')
  }
  const fields = new Map<string, unknown>()
  for (const pair of document.contents.items) {
    if (!isPair(pair) || !isScalar(pair.key) || typeof pair.key.value !== 'string' || fields.has(pair.key.value)) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Bundled standard skill frontmatter is invalid')
    }
    fields.set(pair.key.value, isScalar(pair.value) ? pair.value.value : pair.value?.toJSON())
  }
  const name = fields.get('name')
  const description = fields.get('description')
  const disabled = fields.get('disable-model-invocation')
  if (typeof name !== 'string' || (description !== undefined && typeof description !== 'string') || (disabled !== undefined && typeof disabled !== 'boolean')) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Bundled standard skill frontmatter identity is invalid')
  }
  return { name, description: description ?? null, disableModelInvocation: disabled ?? false }
}

export function standardSkillFrontmatter(content: string): StandardSkillFrontmatter {
  return parseStandardSkillFrontmatter(content)
}

/** Validate the complete standard Skill tree loaded from the single core loader. */
export function validateStandardSkillParity(files: readonly BundledStandardSkillFile[]): StandardSkillParity {
  const expected = new Map<string, (typeof STANDARD_SKILL_MANIFESTS)[number]>(STANDARD_SKILL_MANIFESTS.map((manifest) => [manifest.name, manifest]))
  const seen = new Set<string>()
  let references = 0
  for (const file of files) {
    const manifest = expected.get(file.skillName)
    if (manifest === undefined || !manifest.files.some((relativePath) => String(relativePath) === file.relativePath) || seen.has(`${file.skillName}/${file.relativePath}`)) {
      throw new KiokukoError('INTEGRITY_ERROR', `Unexpected bundled standard skill file: ${file.skillName}/${file.relativePath}`)
    }
    if (markerCount(file.content, file.managedMarker) !== 1) {
      throw new KiokukoError('INTEGRITY_ERROR', `Bundled standard skill marker is invalid: ${file.skillName}/${file.relativePath}`)
    }
    seen.add(`${file.skillName}/${file.relativePath}`)
    if (file.relativePath !== 'SKILL.md') references += 1
  }
  const expectedFiles = STANDARD_SKILL_MANIFESTS.reduce((count, manifest) => count + manifest.files.length, 0)
  if (files.length !== expectedFiles || seen.size !== expectedFiles || expected.size !== 6 || references !== 15) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Bundled standard skill manifest is incomplete')
  }
  for (const manifest of STANDARD_SKILL_MANIFESTS) {
    const primary = files.find((file) => file.skillName === manifest.name && file.relativePath === 'SKILL.md')
    if (primary === undefined) throw new KiokukoError('INTEGRITY_ERROR', `Bundled standard skill primary file is unavailable: ${manifest.name}`)
    const frontmatter = parseStandardSkillFrontmatter(primary.content)
    if (frontmatter.name !== manifest.name || frontmatter.description === null || frontmatter.description.length === 0 || frontmatter.disableModelInvocation) {
      throw new KiokukoError('INTEGRITY_ERROR', `Bundled standard skill frontmatter identity is invalid: ${manifest.name}`)
    }
    const paths = new Set(files.filter((file) => file.skillName === manifest.name).map((file) => file.relativePath))
    for (const file of files) if (file.skillName === manifest.name) validateLinks(file, paths)
  }
  return Object.freeze({
    skills: STANDARD_SKILL_MANIFESTS.map((manifest) => manifest.name),
    files: [...files],
    markdownFileCount: files.length,
    referenceFileCount: references,
    contentDigest: contentDigest(files),
  })
}

export async function loadStandardSkillParity(): Promise<StandardSkillParity> {
  return validateStandardSkillParity(await loadBundledStandardSkillFiles())
}
