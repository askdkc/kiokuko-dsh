import { access, readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'

function relativeModuleSpecifiers(source) {
  const specs = []
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\bexport\s+(?:\*|\{[^}]*\})\s+from\s*)['"]([^'"]+)['"]/g
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1]
    if (specifier?.startsWith('.')) specs.push(specifier)
  }
  return specs
}

export async function assertRelativeClosure(packageRoot, files) {
  const sourceFiles = files
    .map((entry) => entry.path)
    .filter((file) => file.startsWith('dist/') && /\.(?:[cm]?js|d\.ts)$/.test(file))
  const missing = []
  for (const file of sourceFiles) {
    const absolute = join(packageRoot, file)
    const source = await readFile(absolute, 'utf8')
    for (const specifier of relativeModuleSpecifiers(source)) {
      const target = resolve(dirname(absolute), specifier)
      const candidates = [target]
      // Declaration files describe types, so TypeScript resolves a .js
      // specifier to its .d.ts counterpart even when the JS was bundled away.
      // Executable files must still resolve to an actual runtime dependency.
      if (file.endsWith('.d.ts') && target.endsWith('.js')) candidates.push(target.slice(0, -3) + '.d.ts')
      if (extname(target) === '') {
        candidates.push(`${target}.js`, `${target}.mjs`, `${target}.cjs`, `${target}.json`, join(target, 'index.js'))
      }
      let found = false
      for (const candidate of candidates) {
        try {
          await access(candidate)
          found = true
          break
        } catch {
          // Try the next Node/TypeScript output representation.
        }
      }
      if (!found) missing.push({ file, specifier })
    }
  }
  if (missing.length > 0) throw new Error(JSON.stringify({ missingRelativeImports: missing }, null, 2))
}
