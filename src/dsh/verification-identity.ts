import { captureRepositoryState } from '../enno-oduno/repository-state.js'
import type { EnnoRunSnapshot } from '../enno-oduno/types.js'
import { canonicalContentHash } from '../serialization/validate.js'

// A contract revision can outlive repository edits. Replaying evidence for the
// old tree would leave classify_boundary requesting verification forever.
export function verificationBoundaryKey(snapshot: EnnoRunSnapshot): string {
  return `dsh-verify:${canonicalContentHash({
    runId: snapshot.runId,
    revision: snapshot.revision,
    mutationRevision: snapshot.mutationRevision,
    verifiers: snapshot.contract.finalVerifiers,
    repository: captureRepositoryState(snapshot.repositoryRoot),
  })}`
}
