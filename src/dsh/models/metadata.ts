import type { ModelRoute } from "../model-configuration.js";

const owners = new WeakMap<
  object,
  { routeMetadata(provider: string): ModelRoute | undefined }
>();
/** Keep catalog metadata independent of optional transport libraries. */
export function registerOwnedModels(
  llm: object,
  owner: { routeMetadata(provider: string): ModelRoute | undefined },
): () => void {
  owners.set(llm, owner);
  return () => {
    if (owners.get(llm) === owner) owners.delete(llm);
  };
}
export function ownedModelRoute(
  llm: object,
  provider: string,
): ModelRoute | undefined {
  return owners.get(llm)?.routeMetadata(provider);
}
