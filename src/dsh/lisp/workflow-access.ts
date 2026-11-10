import type { CodingWorkflow } from '../coding-workflow/contracts.js'
import { isJournalLispInspection } from '../lisp-tool-identity.js'

/** Presentation and dispatch share this decision; it never grants an effect lease. */
export function lispWorkflowAccess(workflow: CodingWorkflow | undefined, root: string, conversation: boolean) {
  if (workflow && workflow.repositoryRoot !== root)
    return { state: 'owner_mismatch', visibility: 'hidden', effects: 'blocked', recovery: 'Use the workflow owner and its original workspace.' } as const
  if (!workflow || conversation && !workflow.protocol)
    return { state: 'conversation', visibility: 'full', effects: 'available', recovery: null } as const
  if (workflow.choice.state !== 'yes' || workflow.choice.scopeVersion !== workflow.scopeVersion || ['awaiting_lisp_choice', 'cancelled', 'superseded', 'completed'].includes(workflow.state))
    return { state: workflow.state, visibility: 'hidden', effects: 'blocked', recovery: 'Inspect coding_workflow status. Resolve the current choice or explicitly resume the authorized task; do not override cancellation or Stop.' } as const
  if (workflow.state === 'preparing')
    return { state: workflow.state, visibility: 'diagnostics', effects: 'blocked', recovery: 'Inspect coding_workflow status and finish its current preparation. Saved result reads are available; no worker is started. Do not force ready or restart Lisp to bypass preparation.' } as const
  return { state: workflow.state, visibility: 'full', effects: 'available', recovery: null } as const
}

export function isLispWorkflowDiagnostic(execution: { name: string; arguments?: unknown; parent?: unknown }): boolean {
  return execution.parent === undefined && (['lisp_status', 'lisp_hot_status', 'lisp_cancel'].includes(execution.name) || isJournalLispInspection(execution))
}
