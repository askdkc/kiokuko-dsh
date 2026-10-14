import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { CodeRequest } from '../../../../src/dsh/lisp/code-intelligence-contracts.js'

const root = new URL('../../../../', import.meta.url)
const read = (path: string) => readFile(new URL(path, root), 'utf8')
const fixture = JSON.parse(await read('tests/fixtures/code-intelligence-provider-source.json'))
const upstreamFile = (path: string): string => fixture.files[path].content
const providerManifest = JSON.parse(upstreamFile('package.json'))
const providerName = providerManifest.name as string
const guide = await read('docs/code-intelligence.md')
const lispGuide = await read('docs/lisp.md')
const readmes = ['README.md', 'README.ja.md', 'README.zh-CN.md', 'README.ko.md']

// The fixture is immutable historical provider evidence, not Kiokuko's current
// release metadata. Source excerpts carry their official GitHub revision/blob IDs.
test('published-provider documentation follows verified source exports and registration', () => {
  for (const [path, file] of Object.entries(fixture.files) as [string, {content: string; sha: string; display_url: string}][]) {
    const bytes = Buffer.from(file.content)
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    assert.equal(blob, file.sha, `upstream fixture drift: ${path}`)
    assert.ok(file.display_url.includes(`/blob/${fixture.revision}/`))
  }
  const contract = upstreamFile('src/code-intelligence-contracts.ts')
  const serviceName = contract.match(/CODE_INTELLIGENCE_SERVICE = '([^']+)'/)?.[1]
  const serviceVersion = contract.match(/CODE_INTELLIGENCE_VERSION = (\d+)/)?.[1]
  assert.ok(serviceName && serviceVersion, 'official source must declare its contract')
  assert.ok(providerManifest.exports['./code-intelligence-contracts'])
  assert.ok(providerManifest.exports['./code-intelligence'])
  assert.ok(upstreamFile('src/provider.ts').includes(`ctx.provide('${serviceName}', runtime.codeIntelligence)`))
  assert.ok(guide.includes(`v${providerManifest.version}`), 'guide must identify the source-verified released provider')
  assert.ok(guide.includes(`CodeIntelligenceServiceV${serviceVersion}`))
  assert.ok(guide.includes(fixture.release), 'guide must link the verified release')
  assert.doesNotMatch(guide, /The published provider 0\.1\.12 does not expose V1/)
  assert.doesNotMatch(lispGuide, /The published provider v0\.1\.12 does not supply V1/)
})

for (const path of readmes) test(`${path} gives a registry install/update path, not the historical patch prerequisite`, async () => {
  const document = await read(path)
  assert.ok(document.includes(`pnpm dsh plugin --profile web add ${providerName}@latest`), `${path}: missing provider install command`)
  assert.ok(document.includes(`pnpm dsh plugin --profile web update ${providerName} --latest`), `${path}: missing provider update command`)
  assert.ok(document.includes('(docs/code-intelligence.md)'), `${path}: missing setup link`)
  assert.doesNotMatch(document, /patches\/code-intelligence\/README\.md/, `${path}: historical fixture must not be the user prerequisite`)
})

test('capabilities example matches the exported zero-argument Lisp primitive and request schema', async () => {
  const lisp = await read('lisp/tools.lisp')
  const primitive = lisp.match(/\(defun (capabilities) \(\) \(%request "([^"]+)"\)\)/)
  assert.ok(primitive, 'read the public function and arity from Lisp source')
  const adapter = await read('src/dsh/lisp/code-intelligence.ts')
  const rpc = adapter.match(new RegExp(`'${primitive[2]}'\\s*:\\s*'([^']+)'`))
  assert.ok(rpc, 'public Lisp method must be mapped by the actual adapter')
  assert.deepEqual(CodeRequest.parse({ method: rpc[1] }), { method: rpc[1] })
  assert.throws(() => CodeRequest.parse({ method: rpc[1], path: 'unexpected.ts' }))
  const example = `(kioku.code:${primitive[1]})`
  assert.ok(guide.includes(`\n${example}\n`), 'setup guide must show the actual zero-argument expression')
  assert.ok(lispGuide.includes(example), 'API guide must agree with the primitive')
  assert.ok(guide.includes('/kioku-lisp enable'), 'setup must explain enabling the evaluator')
})

test('grammar scope comes from provider structural capabilities rather than its broader LSP router', () => {
  const engine = upstreamFile('src/structure/engine.ts')
  const entries = [...engine.matchAll(/this\.capability\('([^']+)', \[([^\]]+)\]/g)]
  assert.ok(entries.length > 0, 'official structural capability entries are required')
  for (const [, language, rawExtensions] of entries) {
    assert.ok(language && rawExtensions, 'structural capability must name a language and extensions')
    const extensions = [...rawExtensions.matchAll(/'([^']+)'/g)].map(match => match[1])
    assert.ok(guide.toLowerCase().includes(language), `missing structural language: ${language}`)
    for (const extension of extensions) assert.ok(guide.includes(`\`${extension}\``), `missing supported extension: ${extension}`)
  }
  assert.match(guide, /LSP routing is separate from structural support/)
  assert.match(guide, /Linux protected acceptance\s+is not established/)
  assert.match(guide, /configured job\s+is not evidence/)
})
