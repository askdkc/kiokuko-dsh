/** Offline aggregate runs replace only the optional community search boundary. */
export function offlineSkillCatalog(upstream) {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname !== 'skills.sh' && url.hostname !== 'www.skills.sh') return upstream(input, init)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const query = url.searchParams.get('q')
    const limit = Number(url.searchParams.get('limit'))
    if (url.protocol !== 'https:' || url.pathname !== '/api/search' || method !== 'GET'
      || !query || !Number.isInteger(limit) || limit < 1 || limit > 20
      || [...url.searchParams.keys()].some(key => !['q', 'limit', 'owner'].includes(key))
      || init?.body || (input instanceof Request && input.body)) {
      throw new Error('Offline Skill catalog fixture does not support this external request')
    }
    return Response.json({ skills: [], query, count: 0, searchType: 'fuzzy', duration_ms: 0 })
  }
}

globalThis.fetch = offlineSkillCatalog(globalThis.fetch)
