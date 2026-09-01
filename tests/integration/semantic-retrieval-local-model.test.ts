import assert from 'node:assert/strict';
import test from 'node:test';
import { LOCAL_SMALL_PRESET } from '../../src/embedding/presets/local-small.js';
import { createLocalEmbeddingProfile } from '../../src/embedding/profile.js';
import { createLocalTransformersModelLoader } from '../../src/embedding/local-model-loader.js';

test('local loader requests offline q8 mean-normalized feature extraction', async () => {
  const profile = createLocalEmbeddingProfile(LOCAL_SMALL_PRESET).identity;
  let requested: unknown;
  const loader = createLocalTransformersModelLoader({
    pipeline: async (task, model, options) => {
      requested = { task, model, options };
      return async (inputs, callOptions) => {
        assert.deepEqual(callOptions, { pooling: 'mean', normalize: true });
        const data = new Float32Array(inputs.length * 384);
        for (let row = 0; row < inputs.length; row += 1) data[row * 384] = 1;
        return { dims: [inputs.length, 384], data };
      };
    },
  });
  const runtime = await loader.load(profile, '/verified/local-model-root');
  const vectors = await runtime.embed(['query: idempotent retry handling', 'passage: duplicate requests are safe']);
  assert.deepEqual(requested, {
    task: 'feature-extraction',
    model: '/verified/local-model-root',
    options: { dtype: 'q8' },
  });
  assert.equal(vectors.length, 2);
  assert.equal(vectors[0]?.length, 384);
  assert.equal(vectors[0]?.[0], 1);
  await runtime.dispose?.();
});
