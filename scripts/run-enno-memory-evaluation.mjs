// No provider is contacted by this entry point. Real-model quality needs a separately approved evaluation.
console.log(JSON.stringify({ format: 'kiokuko.enno-memory.evaluation.v1', quality: 'unmeasured',
  taskSuccessRate: null, recallAt5RealModel: null, billedTokens: null,
  llmCalls: 0, remoteEmbeddingCalls: 0, rerank: 'not_adopted',
  reason: 'No fixed real-model evaluation set and explicit provider authorization were supplied.' }, null, 2))
