import type { ConfiguredModel, ModelRoute } from "../model-configuration.js";

interface ModelOwner {
  routeMetadata(provider: string): ModelRoute | undefined;
  models(provider: string): PromiseLike<readonly ConfiguredModel[]>;
}

const owners = new WeakMap<
  object,
  ModelOwner
>();
/** Keep catalog metadata independent of optional transport libraries. */
export function registerOwnedModels(
  llm: object,
  owner: ModelOwner,
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
export function ownedModelsForDisplay(llm: object, provider: string): PromiseLike<readonly ConfiguredModel[]> | undefined {
  const owner = owners.get(llm);
  return owner?.routeMetadata(provider) ? owner.models(provider) : undefined;
}
