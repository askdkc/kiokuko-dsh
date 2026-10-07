import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
export const digest = value => createHash('sha256').update(value).digest('hex')

export function requestText(request) {
  return [request.system ?? '', ...request.messages.flatMap(m => m.content.filter(b => b.type === 'text').map(b => b.text))].join('\n')
}

/** Read the actual native session events, never a model-produced "passed" field. */
export function readEvidence(events) {
  const calls = [], results = [], finals = []
  for (const event of events) {
    const message = event.data?.message
    if (event.type === 'assistant/message') for (const block of message?.content ?? []) {
      if (block.type === 'tool-call') {
        let args
        try { args = typeof block.arguments === 'string' ? JSON.parse(block.arguments) : block.arguments } catch { args = null }
        calls.push({ callId: block.id, name: block.name, arguments: args })
      }
      if (block.type === 'text') finals.push(block.text)
    }
    if (event.type === 'tool/result') for (const block of message?.role === 'tool' ? [message]
      : (message?.content ?? []).filter(block => block.type === 'tool-result')) {
      const parts = block.content.filter(b => b.type === 'text').map(b => b.text)
      let value
      try { value = JSON.parse(parts.join('\n')) } catch { value = null }
      results.push({ callId: block.toolCallId, isError: !!block.isError, value, text: parts.join('\n') })
    }
  }
  return { calls, results, final: finals.at(-1) ?? '' }
}

export function assessEvidence(scenario, evidence, beforeDigest, afterDigest, seed) {
  const processResults = evidence.results.map(r => r.value?.value?.json).filter(r => r && Number.isInteger(r.code) && typeof r.stdout === 'string')
  const decoded = processResults.filter(r => r.code === 0).map(r => { try { return JSON.parse(r.stdout.trim()) } catch { return null } })
  let measured = scenario.expected ? decoded.some(r => isDeepStrictEqual(r, scenario.expected)) : false
  if (scenario.id === 'B03') measured = decoded.some(r => r?.warmup >= 1 && r.samples?.length >= 3 && r.samples.every(s => s.equal === true && Number.isFinite(s.arrayMs) && s.arrayMs >= 0 && Number.isFinite(s.setMs) && s.setMs >= 0))
  if (scenario.id === 'B04') {
    const result = seed?.value?.value?.json
    let observed
    try { observed = result?.code === 0 ? JSON.parse(result.stdout.trim()) : null } catch { observed = null }
    measured = isDeepStrictEqual(observed, scenario.expected) && !evidence.calls.some(c => ['lisp_eval', 'lisp_call'].includes(c.name))
  }
  if (scenario.id === 'B05') measured &&= processResults.some(r => r.code !== 0) && new Set(evidence.calls.filter(c => c.name === 'lisp_eval').map(c => c.arguments?.code)).size >= 2
  if (scenario.id === 'B07') measured = evidence.results.some(r => r.isError || r.value?.ok === false || r.value?.error) || processResults.some(r => r.code !== 0)
  const knownRefs = new Set(evidence.results.flatMap(r => [r.value?.operationId, r.value?.resultRef, r.value?.value?.ref]).filter(Boolean))
  if (seed?.value?.operationId) knownRefs.add(seed.value.operationId)
  const claimed = [...evidence.final.matchAll(/\[evidence:([^\]]+)\]/gu)].map(m => m[1])
  const checks = {
    workspaceUnchanged: beforeDigest === afterDigest,
    noApplication: !evidence.calls.some(c => ['lisp_apply', 'lisp_stage'].includes(c.name)) && !evidence.results.some(r => r.value?.proposalCount > 0 || r.value?.changeSummary?.states?.APPLIED > 0 || r.value?.changes?.some(c => c.state === 'APPLIED')),
    observedExpectedOutput: !!measured,
    finalPresent: evidence.final.trim().length > 0,
    evidenceReferencesPresent: claimed.length > 0,
    evidenceReferencesValid: claimed.every(ref => knownRefs.has(ref)),
  }
  return { checks, passed: Object.values(checks).every(Boolean), semanticReview: 'pending', processResults }
}
