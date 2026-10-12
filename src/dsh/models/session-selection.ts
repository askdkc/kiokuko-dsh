import type { HeadWorkerConfiguration } from "../head-worker-configuration.js";
import type { KiokukoModelsService } from "./service.js";

/** Shared session state stays usable without loading optional native UI peers. */
export const mounted = new WeakMap<object, KiokukoModelsService>();
/** The profile service owns durable choices; callers receive defensive snapshots. */
export async function getHeadWorkerSessionSelection(llm: object, sessionId: string): Promise<{ configuration?: HeadWorkerConfiguration; revision: number }> {
  return mounted.get(llm)?.headWorkerSelection(sessionId) ?? { revision: 0 };
}
export async function getHeadWorkerForSession(llm: object, sessionId: string) {
  return (await getHeadWorkerSessionSelection(llm, sessionId)).configuration;
}
export async function clearHeadWorkerForSession(llm: object, sessionId: string, isCurrent?: () => boolean): Promise<void> {
  await mounted.get(llm)?.clearHeadWorker(sessionId, isCurrent);
}
export async function updateHeadWorkerEffortForSession(llm: object, sessionId: string, reasoningEffort: string, isCurrent?: () => boolean): Promise<void> {
  await mounted.get(llm)?.updateHeadWorkerEffort(sessionId, reasoningEffort, isCurrent);
}
