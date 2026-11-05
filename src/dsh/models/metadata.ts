import type { ConfiguredModel, ModelRoute } from "../model-configuration.js";

interface ModelOwner {
  routeMetadata(provider: string): ModelRoute | undefined;
  models(provider: string): PromiseLike<readonly ConfiguredModel[]>;
}

const cordisOriginal = Symbol.for("cordis.original");

/** Cordis can return a fresh proxy on each read of the same service. */
export function modelServiceKey(llm: object): object {
  return (llm as { [cordisOriginal]?: object })[cordisOriginal] ?? llm;
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
  const key = modelServiceKey(llm);
  owners.set(key, owner);
  return () => {
    if (owners.get(key) === owner) owners.delete(key);
  };
}
export function ownedModelRoute(
  llm: object,
  provider: string,
): ModelRoute | undefined {
  return owners.get(modelServiceKey(llm))?.routeMetadata(provider);
}
export function ownedModelsForDisplay(llm: object, provider: string): PromiseLike<readonly ConfiguredModel[]> | undefined {
  const owner = owners.get(modelServiceKey(llm));
  return owner?.routeMetadata(provider) ? owner.models(provider) : undefined;
}
