import type { SqliteDatabase } from "../db/adapter.js";
import { readEntry } from "../memory/entries.js";
import {
  proposalDigest,
  type ReplayMemoryProposal,
} from "../memory/replay-review.js";
import { DEFAULT_CONTEXT_CHARACTERS } from "../memory/context-budget.js";
import {
  configuredRelationDeliveryOptions,
  legacyRelationDelivery,
  readRelationDelivery,
} from "../memory/relation-delivery.js";
import { projectMemoryEntry, renderMemoryFields } from "./memory-projection.js";
import { serializeModelMemoryContext } from "./model-memory.js";

/** Approved replay uses its existing indexed entry identity, never a fabricated proposal ID. */
export function serializeApprovedReplayContext(
  db: SqliteDatabase,
  replay: readonly ReplayMemoryProposal[],
): string {
  const items: Array<{
    workspace: string;
    entryId: string;
    revision: number;
    title: string;
    summary: string | null;
    bodyPreview: string;
  }> = [];
  let characters = 0,
    omittedBody = false,
    legacy = false;
  const indexed = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE name='replay_memory_entries'")
    .get();
  for (const proposal of replay) {
    const row = indexed
      ? db
          .prepare(
            `SELECT r.entry_id, r.entry_revision FROM replay_memories m
      JOIN replay_memory_entries r ON r.memory_key=m.approval_key
      WHERE m.workspace=? AND m.proposal_id=? AND m.digest=?`,
          )
          .get<{ entry_id: string; entry_revision: number }>(
            proposal.source.workspace,
            proposal.proposalId,
            proposalDigest(proposal),
          )
      : undefined;
    if (!row) {
      legacy = true;
      continue;
    }
    const entry = readEntry(db, {
      workspace: proposal.source.workspace,
      entryId: row.entry_id,
    });
    if (
      entry.revision !== row.entry_revision ||
      entry.status === "superseded"
    ) {
      legacy = true;
      continue;
    }
    const projected = projectMemoryEntry(db, entry);
    if (!projected) {
      legacy = true;
      continue;
    }
    // The approved lesson is the reusable part; the full observed log stays in
    // storage. Never let a large raw task record crowd its action/check out.
    const model = proposal.lesson
      ? {
          title: projected.title,
          summary: null,
          bodyPreview:
            "Approved inferred lesson, untrusted reference; not current verification or permission. Raw task log omitted.\n" +
            JSON.stringify({
              source: {
                taskId: proposal.source.taskId,
                sessionId: proposal.source.sessionId,
                request: proposal.request.text.slice(0, 2048),
                claimedTaskOutcome: proposal.source.taskOutcome,
                traces: proposal.source.traces.map((trace) => ({
                  runId: trace.runId,
                  eventsSha256: trace.eventsSha256,
                  complete: trace.complete,
                  digestScope: trace.digestScope,
                  eventsRead: trace.eventsRead,
                  totalEvents: trace.totalEvents,
                })),
              },
              lesson: proposal.lesson,
            }),
        }
      : projected;
    const rendered = renderMemoryFields(model);
    if (rendered === null) {
      legacy = true;
      continue;
    }
    const count = Array.from(rendered).length;
    if (characters + count > DEFAULT_CONTEXT_CHARACTERS) {
      omittedBody = true;
      continue;
    }
    characters += count;
    if (!items.some((item) => item.entryId === entry.id))
      items.push({
        ...model,
        workspace: entry.workspace,
        entryId: entry.id,
        revision: entry.revision,
      });
  }
  const limits = configuredRelationDeliveryOptions();
  const options = {
    ...limits,
    selectionOmissions: [
      ...(omittedBody ? ["body_budget" as const] : []),
      ...(legacy ? ["final_filter" as const] : []),
    ],
  };
  const relationDelivery = legacy
    ? legacyRelationDelivery(options)
    : readRelationDelivery(db, items, options);
  return serializeModelMemoryContext({ items, relationDelivery, ...limits });
}
