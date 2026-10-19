export const repeatedMemoryScenarios = Object.freeze([
  ...['normal', 'enno'].flatMap(route => ['prefix_reuse', 'bounded_evidence'].flatMap(mode =>
    ['same-session', 'new-session', 'restart'].map(scenario => `${route}/${mode}/${scenario}`))),
  ...['prefix_reuse', 'bounded_evidence'].flatMap(mode =>
    ['duplicate-completion', 'save-failure', 'correction', 'upgrade'].map(scenario => `normal/${mode}/${scenario}`)),
  ...['prefix_reuse', 'bounded_evidence'].flatMap(mode => ['stale-revision', 'stale-lease'].map(scenario => `enno/${mode}/${scenario}`)),
  ...['same-session', 'restart', 'dispatched-interruption'].map(scenario => `deep/${scenario}`),
])

export function selectedRepeatedScenarios(environment=process.env) {
  const single=environment.KIOKUKO_REPEATED_SCENARIO,multiple=environment.KIOKUKO_REPEATED_SCENARIOS
  if(single!==undefined&&multiple!==undefined)throw new Error('Select one repeated lifecycle scope')
  const selected=single!==undefined?[single]:multiple!==undefined?JSON.parse(multiple):[...repeatedMemoryScenarios]
  if(!Array.isArray(selected)||!selected.length||new Set(selected).size!==selected.length||selected.some(name=>!repeatedMemoryScenarios.includes(name)))throw new Error('Unknown, empty or duplicate required lifecycle scenarios')
  return selected
}
