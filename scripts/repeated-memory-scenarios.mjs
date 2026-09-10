export const repeatedMemoryScenarios = Object.freeze([
  ...['normal', 'enno'].flatMap(route => ['prefix_reuse', 'bounded_evidence'].flatMap(mode =>
    ['same-session', 'new-session', 'restart'].map(scenario => `${route}/${mode}/${scenario}`))),
  ...['prefix_reuse', 'bounded_evidence'].flatMap(mode =>
    ['duplicate-completion', 'save-failure', 'correction', 'adoption-source', 'adoption-mode', 'adoption-lease', 'dispatched-interruption', 'upgrade'].map(scenario => `normal/${mode}/${scenario}`)),
  ...['prefix_reuse', 'bounded_evidence'].flatMap(mode => ['stale-revision', 'stale-lease'].map(scenario => `enno/${mode}/${scenario}`)),
  ...['same-session', 'restart', 'dispatched-interruption'].map(scenario => `deep/${scenario}`),
])
