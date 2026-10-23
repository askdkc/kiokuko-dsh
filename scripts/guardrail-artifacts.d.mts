/** Test overrides select packaged targets; normal enrollment uses the actual host. */
export interface GuardrailResolveOptions { platform?: string; arch?: string }
export interface ResolvedGuardrail {
  binary: string
  protocol: string
  engineDigest: string
  protocolFileDigest: string
  manifestDigest: string
  version: string
  target: string
}
/** Verify bundled file identities and format synchronously; no execution or network fallback. */
export function resolveGuardrail(root: string, options?: GuardrailResolveOptions): ResolvedGuardrail

/** Verify the frozen source and release provenance in a repository checkout. */
export function verifyGuardrailSource(root: string): string
