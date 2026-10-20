import type { Evidence, Signal } from '../types.ts';

const MAX_EVIDENCE = 6;
const MAX_ITEMS = 24;
/** Each further piece of evidence counts less: five weak hints are not one strong fact. */
const DECAY = 0.6;

interface Item {
  evidence: Evidence;
  /** Strongest reading from add(); 0 if the fact only came through atLeast(). Counts toward the strength. */
  counted: number;
  /** Strongest reading from either call; orders the evidence list. */
  shown: number;
}

interface Entry {
  floor: number;
  items: Item[];
}

/**
 * Collects signals. Observations combine as a noisy-OR over the evidence sorted from strongest
 * to weakest, with diminishing weight, so the strongest evidence is listed (and quoted) first.
 * atLeast() sets a floor and lists its evidence without adding to the combination.
 */
export class SignalSet {
  private readonly map = new Map<string, Entry>();

  add(id: string, strength: number, evidence: Evidence): void {
    this.put(id, strength, evidence, true);
  }

  /** Raise a signal to at least `strength` without adding noise. */
  atLeast(id: string, strength: number, evidence: Evidence): void {
    this.put(id, strength, evidence, false);
  }

  private put(id: string, strength: number, evidence: Evidence, counts: boolean): void {
    const s = Math.max(0, Math.min(1, strength));
    let e = this.map.get(id);
    if (!e) {
      e = { floor: 0, items: [] };
      this.map.set(id, e);
    }
    if (!counts) e.floor = Math.max(e.floor, s);
    let item = e.items.find((i) => i.evidence.source === evidence.source && i.evidence.detail === evidence.detail);
    if (!item) {
      item = { evidence, counted: 0, shown: 0 };
      e.items.push(item);
    }
    // The same fact seen twice is still one fact: keep its strongest reading.
    if (counts) item.counted = Math.max(item.counted, s);
    item.shown = Math.max(item.shown, s);
    if (e.items.length > MAX_ITEMS) {
      // Drop floor-only facts before counted ones, then the weakest.
      e.items.sort((a, b) => b.counted - a.counted || b.shown - a.shown);
      e.items.length = MAX_ITEMS;
    }
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  get(id: string): Signal | undefined {
    const e = this.map.get(id);
    return e ? toSignal(id, e) : undefined;
  }

  toRecord(): Record<string, Signal> {
    const out: Record<string, Signal> = {};
    for (const id of [...this.map.keys()].sort()) {
      const s = toSignal(id, this.map.get(id) as Entry);
      out[id] = { ...s, strength: Math.round(s.strength * 100) / 100 };
    }
    return out;
  }
}

function toSignal(id: string, e: Entry): Signal {
  // Stable sorts: equal strengths keep the order they were found in.
  const counted = e.items.filter((i) => i.counted > 0).sort((a, b) => b.counted - a.counted);
  const sources = new Set<string>();
  let miss = 1;
  counted.forEach((i, k) => {
    // Several facts from one file (30 classes in one project file) are not independent.
    const sameFile = sources.has(i.evidence.source);
    sources.add(i.evidence.source);
    miss *= 1 - i.counted * (sameFile ? 0.5 : 1) * DECAY ** k;
  });
  const shown = [...e.items].sort((a, b) => b.shown - a.shown);
  return { id, strength: Math.max(e.floor, 1 - miss), evidence: shown.slice(0, MAX_EVIDENCE).map((i) => i.evidence) };
}
