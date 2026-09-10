/** Streaming, bounded selection of indivisible evidence groups. */
export interface EvidenceGroup<T> {
  readonly items: readonly T[];
  readonly seq: number;
  readonly kind: 'user' | 'failed' | 'pair' | 'other';
}

export class EvidenceSelection<T> {
  #groups: EvidenceGroup<T>[] = [];
  constructor(readonly maximumItems: number, readonly maximumBytes: number, readonly render: (items: readonly T[]) => string = JSON.stringify) {}

  add(group: EvidenceGroup<T>): void {
    if (group.items.length === 0 || group.items.length > this.maximumItems || Buffer.byteLength(this.render(group.items)) > this.maximumBytes) return;
    // Keep the latest human input and latest failed execution ahead of pairs;
    // older inputs/results compete by recency after complete pairs.
    const groups = [...this.#groups, group];
    const latestUser = Math.max(-1, ...groups.filter(item => item.kind === 'user').map(item => item.seq));
    const latestFailure = Math.max(-1, ...groups.filter(item => item.kind === 'failed').map(item => item.seq));
    const priority = (item: EvidenceGroup<T>): number => item.kind === 'user' && item.seq === latestUser ? 4
      : item.kind === 'failed' && item.seq === latestFailure ? 3 : item.kind === 'pair' || item.kind === 'failed' && item.items.length > 1 ? 2 : 1;
    groups.sort((a,b) => priority(b) - priority(a) || b.seq - a.seq);
    const selected: EvidenceGroup<T>[] = [];
    let items: T[] = [];
    for (const candidate of groups) {
      const next = [...items, ...candidate.items];
      if (next.length > this.maximumItems || Buffer.byteLength(this.render(next)) > this.maximumBytes) continue;
      selected.push(candidate); items = next;
    }
    this.#groups = selected;
  }

  items(): T[] {
    return this.#groups.slice().sort((a,b) => a.seq - b.seq).flatMap(group => [...group.items]);
  }

  document(maximumBytes = this.maximumBytes): string {
    const bounded = new EvidenceSelection<T>(this.maximumItems, maximumBytes, this.render);
    for (const group of this.#groups) bounded.add(group);
    return this.render(bounded.items());
  }
}
