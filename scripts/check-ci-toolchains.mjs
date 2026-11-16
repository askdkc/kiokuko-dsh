import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function checkToolchainSelectors(source) {
  const failures = []
  let pnpmSetup = false
  const dynamicNode = /^\$\{\{\s*needs\.select\.outputs\.node_version(?:\s*\|\|\s*'latest')?\s*\}\}/
  for (const [index, line] of source.split('\n').entries()) {
    const input = line.trim()
    if (input.startsWith('#')) continue
    if (input.startsWith('- ')) pnpmSetup = false
    if (/\buses:\s*pnpm\/action-setup@/.test(input)) pnpmSetup = true
    const node = /\bnode-version:\s*(['"]?)(.*)/.exec(input)?.[2]
    if (/\bnode-version-file:/.test(input) || node && !/^latest(?:['",}\s]|$)/.test(node) && !dynamicNode.test(node)) {
      failures.push(`${index + 1}: select Node with latest or the selection job output`)
    }
    if (/rustup\s+toolchain\s+install\s+(?!stable(?:\s|$))|rustup\s+which\s+--toolchain\s+(?!stable(?:\s|$))/.test(input)) {
      failures.push(`${index + 1}: select Rust with stable`)
    }
    const pnpm = pnpmSetup ? /\bversion:\s*['"]?([^'",}#\s]+)/.exec(input)?.[1] : undefined
    if ((pnpm && pnpm !== 'latest') || /\b(?:pnpm|npm)@(?!(?:latest)(?:['"\s]|$))|\bpnpmVersion\b/.test(input)) {
      failures.push(`${index + 1}: select Kiokuko's package manager with latest`)
    }
    if (/\bciToolchain\b/.test(input)) failures.push(`${index + 1}: record the runtime toolchain instead of hard-coding an expected version`)
  }
  return failures
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const root = join(import.meta.dirname, '..')
  const workflows = ['.github/workflows', '.depot/workflows']
    .flatMap(folder => readdirSync(join(root, folder))
      .filter(file => /\.ya?ml$/.test(file)).map(file => join(folder, file)))
  const errors = [...workflows, 'scripts/ci-plan.mjs', 'scripts/verification.json']
    .flatMap(file => checkToolchainSelectors(readFileSync(join(root, file), 'utf8')).map(error => `${file}:${error}`))
  if (errors.length) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  }
}
