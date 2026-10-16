import { join } from 'node:path'
import type { CoreLibrary, TraceWriter } from './agenticreplay-libraries.js'

/** Keep SDK redaction enabled when its serialized-text pass consumes a JSON escape. */
export function redactionSafeWriter(writer: TraceWriter, core: CoreLibrary): TraceWriter {
  if (!core.Redactor || !core.BlobStore) return writer
  const redactor = new core.Redactor()
  const blobs = new core.BlobStore(join(writer.runDir, 'blobs'))
  const rules = new Set<string>()
  const redact = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const result = redactor.redactString(value, 'dsh.structured-payload')
      for (const hit of result.hits) rules.add(hit.rule)
      return result.value
    }
    if (Array.isArray(value)) return value.map(redact)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redact(item)]))
    return value
  }
  return {
    get runDir() { return writer.runDir },
    close: () => writer.close(),
    append: async event => {
      if (event.payload !== undefined) {
        const scrubbed = redactor.redactString(JSON.stringify(event.payload), 'dsh.payload-preflight')
        let valid = true
        try { JSON.parse(scrubbed.value) } catch (error) {
          if (!(error instanceof SyntaxError)) throw error
          valid = false
        }
        if (!valid) {
          // Preflight precedes append: never retry an append with an unknown outcome.
          // The same SDK redacts each field before JSON encoding and private blob storage.
          rules.clear()
          const payload = await blobs.put(JSON.stringify(redact(event.payload)), 'application/json')
          return writer.append({ ...event, payload, attrs: { ...event.attrs,
            dsh_payload_encoding: 'structured-redacted-json', dsh_payload_redaction_rules: [...rules].sort() } })
        }
      }
      return writer.append(event)
    },
  }
}
