import { readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../lisp/vendor')
const files = {}
// Upstream-generated test fixtures are ignored by Git and excluded from npm.
// Runtime Unicode tables (lists/hash-tables/methods.lisp) remain required.
const generatedTests = new Set(['cl-unicode/test/derived-properties', 'cl-unicode/test/normalization-forms'])
async function scan(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    // npm omits these control files even with an explicit files allowlist.
    if (entry.name === '.gitignore' || entry.name === '.npmignore') continue
    const path = join(directory, entry.name)
    const name = relative(root, path).split('\\').join('/')
    if (generatedTests.has(name)) continue
    if (entry.isSymbolicLink()) throw new Error(`Vendored symlink: ${path}`)
    if (entry.isDirectory()) await scan(path)
    else files[name] = createHash('sha256').update(await readFile(path)).digest('hex')
  }
}
await scan(root)
const path = resolve(root, '../vendor-manifest.json')
if (process.argv.includes('--write')) await writeFile(path, JSON.stringify({ format: 1, files }, null, 2) + '\n')
else {
  const expected = JSON.parse(await readFile(path, 'utf8'))
  if (JSON.stringify(expected.files) !== JSON.stringify(files)) throw new Error('Lisp vendor content differs from the reviewed manifest')
}
console.log(`Lisp vendor: ${Object.keys(files).length} files verified`)
