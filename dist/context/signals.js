

const MAX_EVIDENCE = 6;

/** Collects signals; repeated observations combine as a noisy-OR. */
export class SignalSet {
                   map = new Map                ();

  add(id        , strength        , evidence          )       {
    const s = Math.max(0, Math.min(1, strength));
    const cur = this.map.get(id);
    if (!cur) {
      this.map.set(id, { id, strength: s, evidence: [evidence] });
      return;
    }
    // Same source repeated (e.g. 30 .cs files) should not keep inflating the strength.
    const dup = cur.evidence.some((e) => e.source === evidence.source && e.detail === evidence.detail);
    if (dup) return;
    const sameSource = cur.evidence.some((e) => e.source === evidence.source);
    const effective = sameSource ? s * 0.5 : s;
    cur.strength = 1 - (1 - cur.strength) * (1 - effective);
    if (cur.evidence.length < MAX_EVIDENCE) cur.evidence.push(evidence);
  }

  /** Raise a signal to at least `strength` without adding noise. */
  atLeast(id        , strength        , evidence          )       {
    const cur = this.map.get(id);
    if (!cur) {
      this.map.set(id, { id, strength, evidence: [evidence] });
      return;
    }
    if (cur.strength < strength) cur.strength = strength;
    if (cur.evidence.length < MAX_EVIDENCE && !cur.evidence.some((e) => e.source === evidence.source && e.detail === evidence.detail)) {
      cur.evidence.push(evidence);
    }
  }

  has(id        )          {
    return this.map.has(id);
  }

  get(id        )                     {
    return this.map.get(id);
  }

  toRecord()                         {
    const out                         = {};
    for (const id of [...this.map.keys()].sort()) {
      const s = this.map.get(id)          ;
      out[id] = { id, strength: Math.round(s.strength * 100) / 100, evidence: s.evidence };
    }
    return out;
  }
}
