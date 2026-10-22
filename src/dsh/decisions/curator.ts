import type { CuratorBackend } from '../../memory/curator-classification.js';
import { CURATOR_CLASSIFICATION_POLICY } from '../../memory/curator-classification.js';
import type { DecisionService } from './service.js';

/** Uses the configured provider unchanged. No correction labels or provider substitution. */
export async function curatorClassifier(service?: DecisionService): Promise<CuratorBackend | undefined> {
  if (!service) return;
  await service.initialize();
  if (!service.curatorClassificationEnabled()) return;
  const configurationDigest = service.configurationDigest();
  return { configurationDigest, isCurrent: () => service.curatorClassificationEnabled() && service.configurationDigest() === configurationDigest, async evaluate(id, batch, signal) {
    if (service.configurationDigest() !== configurationDigest) return { status: 'fallback', reason: 'configuration_changed' };
    const outcome = await service.evaluate(id, batch, signal, CURATOR_CLASSIFICATION_POLICY);
    return service.configurationDigest() === configurationDigest ? outcome : { status: 'fallback', reason: 'configuration_changed' };
  } };
}
