/** The PTC transport permits logs (and optional sandbox), not an arbitrary result.
 * Keep the host receipt in both the canonical log value and model-visible content. */
export function preparationCarrierResult(result: unknown) {
  const text = JSON.stringify(result)
  return { isError: false as const, value: { logs: [text] }, content: [{ type: 'text' as const, text }] }
}
