import assert from 'node:assert/strict'
import YAML from 'yaml'

export const requiredInject = ['skills', 'systemPrompt', 'tools', 'commands', 'sessions', 'sessionQuery', 'sessionPersistence', 'agents', 'subagents']

export function parseRows(stdout) {
  const document = YAML.parseDocument(stdout, { strict: true, uniqueKeys: true })
  assert.equal(document.errors.length, 0, `invalid DSH config YAML: ${document.errors.map(String).join('; ')}`)
  const rows = document.toJS()
  assert.ok(Array.isArray(rows), 'DSH config must be an entry array')
  return rows
}

export function assertKiokukoInstalled(rows) {
  const matches = rows.filter(row => row?.id === 'kiokuko-dsh' || row?.name === 'kiokuko-dsh')
  assert.equal(matches.length, 1, 'exactly one Kiokuko entry is required, including disabled entries')
  const [row] = matches
  assert.equal(row.id, 'kiokuko-dsh')
  assert.equal(row.name, 'kiokuko-dsh')
  assert.notEqual(row.disabled, true)
  assert.equal(row.config?.enabled, true)
  assert.equal(row.config?.orca?.enabled, true)
  for (const service of requiredInject) assert.ok(row.inject?.includes(service), `Kiokuko inject is missing ${service}`)
}

export function assertTuiServicesConfigured(rows) {
  for (const id of ['dsh-tui', 'commands', 'session-persistence-jsonl']) {
    assert.equal(rows.filter(row => row?.id === id && row.disabled !== true).length, 1, `expected one enabled ${id} entry`)
  }
}

export function assertExpectedPatchWarning(stderr) {
  const diagnostics = stderr.split(/\r?\n/u).map(line => line.trim()).filter(line => /warn|error|not found/iu.test(line))
  assert.deepEqual(diagnostics, ['dsh: [kiokuko-dsh] patch: entry "session-log-download" not found'])
}

export function assertRemoved(before, after) {
  assert.equal(after.filter(row => row?.id === 'kiokuko-dsh' || row?.name === 'kiokuko-dsh').length, 0)
  assert.deepEqual(after, before, 'TUI profile must return to its pre-Kiokuko configuration')
}
