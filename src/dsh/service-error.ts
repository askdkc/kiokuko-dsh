/** A host service failure that can be translated without importing an execution module. */
export class HostServiceError extends Error {
  constructor(readonly code: string, message: string, readonly recovery: string) { super(message) }
}
