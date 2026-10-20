// The recommendation engine. Pure: takes project context, registry and inventory,
// returns ranked recommendations. No I/O, no host-specific code.

import type {
  Availability,
  HostId,
  Inventory,
  ProjectContext,
  Reason,
  Recommendation,
  RecommendationAction,
  Registry,
  RegistryEntry,
  ScoreBreakdown,
} from '../types.ts';
import { availabilityFor, hostLabel, primaryEntryFor, serverMatchScore, urlPatternIn } from '../hosts/inventory.ts';
import { isLegacy, isRetired } from '../registry/registry.ts';
import { platformName } from '../util/paths.ts';

export interface RecommendOptions {
  hosts: HostId[];
  minScore?: number;
  limit?: number;
  /** Returns a description if the user dismissed this entry (shown items are filtered out). */
  isDismissed?: (id: string) => string | undefined;
  includeDismissed?: boolean;
  previousSignals?: string[];
  platform?: NodeJS.Platform;
  now?: number;
}

export interface Suppressed {
  id: string;
  reason: string;
}

export interface RecommendResult {
  recommendations: Recommendation[];
  /** Relevant entries that are already set up (or covered by an equivalent tool). */
  alreadyAvailable: Recommendation[];
  suppressed: Suppressed[];
  /** Group members folded into a better entry's alternatives (still explainable). */
  folded: Recommendation[];
}

/** Signals from example and fixture folders are capped at this strength and never open a gate. */
const SAMPLE_CAP = 0.3;

const FREQ = { daily: 1, weekly: 0.7, occasional: 0.4 } as const;
const EFFORT_COST = { low: 0.03, medium: 0.07, high: 0.15 } as const;
const AUTH_COST = { none: 0, oauth: 0.02, token: 0.04, connection: 0.04, cloud: 0.04, 'local-app': 0.02, unknown: 0.06 } as const;
const LEVEL_RISK = { read: 0, write: 0.06, exec: 0.08, admin: 0.1 } as const;

function uniq(xs: string[]): string[] {
  // "X (Claude Code)", "X (Codex)" -> "X (Claude Code, Codex)"
  const groups = new Map<string, string[]>();
  for (const x of new Set(xs)) {
    const m = /^(.*) \((Claude Code|Codex)\)$/.exec(x);
    const key = m && m[1] ? m[1] : x;
    const list = groups.get(key) ?? [];
    if (m && m[2]) list.push(m[2]);
    groups.set(key, list);
  }
  return [...groups].map(([k, hosts]) => (hosts.length ? `${k} (${hosts.join(', ')})` : k));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Relevance from triggers plus team-configured servers for other clients. */
export function relevance(entry: RegistryEntry, ctx: ProjectContext): { value: number; reasons: Reason[]; gated: boolean } {
  const reasons: Reason[] = [];
  let miss = 1;
  for (const t of entry.triggers) {
    const s = ctx.signals[t.signal];
    if (!s || s.strength <= 0) continue;
    miss *= 1 - t.weight * s.strength;
    reasons.push({ signal: t.signal, strength: s.strength, weight: t.weight, evidence: s.evidence });
  }
  let teamSignal = false;
  for (const [id, s] of Object.entries(ctx.signals)) {
    if (!id.startsWith('team-mcp:')) continue;
    const fp = id.slice('team-mcp:'.length);
    const hit = (entry.match.urls ?? []).some((u) => urlPatternIn(fp, u)) || (entry.match.packages ?? []).some((p) => fp.includes(p.toLowerCase()));
    if (!hit) continue;
    teamSignal = true;
    miss *= 1 - 0.8 * s.strength;
    reasons.push({ signal: 'team:other-client', strength: s.strength, weight: 0.8, evidence: s.evidence });
  }
  const gated = entry.requiresAny ? !teamSignal && !entry.requiresAny.some((sig) => (ctx.signals[sig]?.strength ?? 0) > SAMPLE_CAP) : false;
  reasons.sort((a, b) => b.weight * b.strength - a.weight * a.strength);
  return { value: 1 - miss, reasons, gated };
}

function fromTask(r: Reason): boolean {
  return r.evidence.some((e) => e.source === 'task');
}

function compatFactor(entry: RegistryEntry, hosts: HostId[]): number {
  let best = 0;
  for (const h of hosts) {
    const s = entry.hosts[h].support;
    best = Math.max(best, s === 'yes' ? 1 : s === 'unknown' ? 0.8 : 0);
  }
  return best;
}

function daysBetween(a: string, nowMs: number): number {
  const t = Date.parse(a + 'T00:00:00Z');
  return Number.isFinite(t) ? (nowMs - t) / 86_400_000 : Infinity;
}

export function recommend(ctx: ProjectContext, registry: Registry, inv: Inventory, opts: RecommendOptions): RecommendResult {
  const hosts = opts.hosts;
  const now = opts.now ?? Date.now();
  const platform = platformName(opts.platform ?? process.platform);
  const minScore = opts.minScore ?? 30;
  const prev = new Set(opts.previousSignals ?? []);
  const suppressed: Suppressed[] = [];
  const recs: Recommendation[] = [];
  const available: Recommendation[] = [];
  const entriesById = new Map(registry.entries.map((e) => [e.id, e]));

  // Which capabilities are already covered, per host, and by what.
  const coveredBy = new Map<string, Array<{ host: HostId; entry: RegistryEntry; label: string; legacy: boolean; viaCli: boolean }>>();
  for (const s of inv.servers) {
    if (!s.enabled || !hosts.includes(s.host)) continue;
    const primary = primaryEntryFor(registry.entries, s);
    if (!primary || primary.score < 100) continue;
    for (const cap of primary.entry.provides) {
      const list = coveredBy.get(cap) ?? [];
      const label = primary.entry.name.toLowerCase().includes(s.name.toLowerCase()) ? `${primary.entry.name} (${hostLabel(s.host)})` : `${primary.entry.name} as "${s.name}" (${hostLabel(s.host)})`;
      list.push({ host: s.host, entry: primary.entry, label, legacy: isRetired(primary.entry), viaCli: false });
      coveredBy.set(cap, list);
    }
  }
  // A configured legacy server is itself evidence that its successor is relevant.
  const replacing = new Map<string, Reason>();
  for (const list of coveredBy.values()) {
    for (const c of list) {
      if (!c.legacy || !c.entry.successor) continue; // only retired (deprecated/archived/removed) entries
      if (!replacing.has(c.entry.successor)) {
        replacing.set(c.entry.successor, { signal: 'configured:legacy', strength: 1, weight: 0.9, evidence: [{ source: 'config', detail: `${c.label} is ${c.entry.status}` }] });
      }
    }
  }
  for (const e of registry.entries) {
    if (e.kind !== 'cli') continue;
    if (!(e.match.executables ?? []).some((x) => inv.executables[x])) continue;
    for (const cap of e.provides) {
      const list = coveredBy.get(cap) ?? [];
      for (const h of hosts) list.push({ host: h, entry: e, label: `${e.name} on PATH`, legacy: false, viaCli: true });
      coveredBy.set(cap, list);
    }
  }

  for (const entry of registry.entries) {
    if (isLegacy(entry) || entry.triggers.length === 0) continue;
    const rel = relevance(entry, ctx);
    const replacement = replacing.get(entry.id);
    if (replacement) {
      rel.value = 1 - (1 - rel.value) * (1 - replacement.weight * replacement.strength);
      rel.reasons.unshift(replacement);
      rel.gated = false;
    }
    if (rel.gated || rel.value <= 0) continue;

    if (!entry.platforms.includes(platform)) {
      suppressed.push({ id: entry.id, reason: `not available on ${platform}` });
      continue;
    }
    const compat = compatFactor(entry, hosts);
    if (compat === 0) {
      suppressed.push({ id: entry.id, reason: `not available for ${hosts.map(hostLabel).join(' / ')}` });
      continue;
    }
    const dismissed = opts.isDismissed?.(entry.id);
    if (dismissed && !opts.includeDismissed) {
      suppressed.push({ id: entry.id, reason: dismissed });
      continue;
    }

    // Availability per host.
    const availability: Partial<Record<HostId, Availability>> = {};
    for (const h of hosts) availability[h] = availabilityFor(entry, inv, h, registry.entries);
    const relevantHosts = hosts.filter((h) => availability[h]?.state !== 'incompatible');
    const configuredHosts = relevantHosts.filter((h) => availability[h]?.state === 'configured');
    const missingHosts = relevantHosts.filter((h) => availability[h]?.state !== 'configured');

    // Equivalent capability already present (other entries).
    const overlaps = entry.provides.flatMap((cap) => (coveredBy.get(cap) ?? []).filter((c) => c.entry.id !== entry.id && missingHosts.includes(c.host)));
    const legacyOverlap = overlaps.filter((o) => o.legacy && o.entry.successor === entry.id);
    const activeMcpOverlap = overlaps.filter((o) => !o.legacy && !o.viaCli);
    const cliOverlap = overlaps.filter((o) => o.viaCli);

    let action: RecommendationAction = 'install';
    let overlap = 1;
    // An equivalent tool counts as a duplicate only if it covers everything this one provides.
    const fullyCovered = (h: HostId): boolean =>
      entry.provides.length > 0 && entry.provides.every((cap) => (coveredBy.get(cap) ?? []).some((c) => c.host === h && c.entry.id !== entry.id && !c.legacy && !c.viaCli));
    if (legacyOverlap.length > 0) action = 'replace';
    else if (missingHosts.length > 0 && missingHosts.every(fullyCovered)) {
      action = 'use-existing';
      overlap = 0.6;
    } else if (activeMcpOverlap.length > 0) {
      overlap = 0.85;
    } else if (cliOverlap.length > 0) {
      overlap = 0.8;
    }
    if (entry.kind === 'cli' || entry.kind === 'skill' || entry.kind === 'plugin') {
      if (action === 'install') action = 'consider';
    }

    // Value, cost, risk.
    const value = (entry.value.timeSaved / 3) * 0.6 + FREQ[entry.value.frequency] * 0.4;
    // With an explicit task, tools that match the task outrank generally useful ones.
    const immediacy = rel.reasons.some(fromTask) ? 1 : ctx.task ? 0.25 : 0.5;
    const missingReqs = (entry.install?.requires ?? []).filter((x) => !inv.executables[x]);
    const setupCost = EFFORT_COST[entry.setup.effort] + AUTH_COST[entry.auth.type] + Math.min(0.06, missingReqs.length * 0.03);
    const usesReadOnly = Boolean(entry.install?.readOnly) || entry.access.level === 'read';
    let risk = usesReadOnly ? 0.01 : LEVEL_RISK[entry.access.level];
    if (entry.credibility === 'community') risk += 0.04;
    if (entry.status === 'preview') risk += 0.04;
    if (entry.status === 'unknown') risk += 0.06;
    if (entry.origin === 'custom') risk += 0.03;
    risk += Math.min(0.08, entry.incomplete.length * 0.02);

    const fit = rel.value * (0.55 + 0.25 * value + 0.2 * immediacy) * compat * overlap;
    let score = Math.round(100 * Math.max(0, Math.min(1, fit - setupCost - risk)));
    if (action === 'replace') score = Math.max(score, 70);

    // Confidence and uncertainty.
    const uncertainty: string[] = [];
    const top = rel.reasons[0];
    const maxStrength = Math.max(0, ...rel.reasons.map((r) => r.strength));
    // A strong signal with a small weight (say, "uses GitHub" for a review plugin) is weak support.
    const support = Math.max(0, ...rel.reasons.map((r) => r.strength * r.weight));
    for (const h of missingHosts) {
      const a = availability[h];
      if (a?.state === 'unknown') uncertainty.push(a.detail);
      if (entry.hosts[h].support === 'unknown') uncertainty.push(`${hostLabel(h)} support is not verified`);
    }
    if (maxStrength < 0.6) uncertainty.push('based on weak evidence only');
    if (entry.status !== 'active') uncertainty.push(`project status: ${entry.status}${entry.statusNote ? ` (${entry.statusNote})` : ''}`);
    if (entry.incomplete.length) uncertainty.push(`registry metadata incomplete: ${entry.incomplete.join(', ')}`);
    const age = entry.verifiedAt ? daysBetween(entry.verifiedAt, now) : Infinity;
    if (age > 180) uncertainty.push(entry.verifiedAt ? `registry facts last verified ${entry.verifiedAt}` : 'registry facts have no verification date');
    // Setup notes are shown with the uncertainty but do not lower confidence in the match itself.
    const setupNotes: string[] = missingReqs.length ? [`needs ${missingReqs.join(', ')} on PATH (not found)`] : [];
    for (const h of missingHosts) {
      const a = availability[h];
      if (a && a.servers.length > 0 && a.state !== 'configured') uncertainty.push(`${hostLabel(h)}: ${a.detail}`);
    }
    let confidence: Recommendation['confidence'] = 'low';
    if (maxStrength >= 0.8 && support >= 0.4 && uncertainty.length === 0) confidence = 'high';
    else if (maxStrength >= 0.5 && support >= 0.2 && uncertainty.length <= 2) confidence = 'medium';
    uncertainty.push(...setupNotes);

    const breakdown: ScoreBreakdown = {
      relevance: round2(rel.value),
      value: round2(value),
      immediacy,
      compatibility: compat,
      setupCost: round2(setupCost),
      risk: round2(risk),
      overlap,
    };

    const rec: Recommendation = {
      id: entry.id,
      entry,
      score,
      confidence,
      action,
      reasons: rel.reasons,
      whyNow: whyNow(entry, rel.reasons, {
        legacyOverlap: uniq(legacyOverlap.map((o) => o.label)),
        activeOverlap: action === 'use-existing' ? uniq(activeMcpOverlap.map((o) => o.label)) : [],
        partialOverlap: action === 'use-existing' ? [] : uniq(activeMcpOverlap.map((o) => o.label)),
        cliOverlap: uniq(cliOverlap.map((o) => o.label)),
      }),
      breakdown,
      availability,
      uncertainty: [...new Set(uncertainty)],
      alternatives: (entry.alternatives ?? []).filter((a) => entriesById.has(a)),
      newSignals: rel.reasons.map((r) => r.signal).filter((s) => prev.size > 0 && !prev.has(s) && !s.startsWith('task:') && ctx.signals[s] !== undefined),
    };
    if (top === undefined) continue;

    if (missingHosts.length === 0 && configuredHosts.length > 0) {
      rec.action = 'use-existing';
      available.push(rec);
      continue;
    }
    if (action === 'use-existing') {
      available.push(rec);
      continue;
    }
    if (score < minScore) {
      suppressed.push({ id: entry.id, reason: `score ${score} below threshold ${minScore}` });
      continue;
    }
    recs.push(rec);
  }

  // Groups: keep the best entry per group, fold the others into its alternatives.
  recs.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const byGroup = new Map<string, Recommendation>();
  const kept: Recommendation[] = [];
  const folded: Recommendation[] = [];
  for (const r of recs) {
    const g = r.entry.group;
    // A replacement for a retired server you use is specific advice; never fold it away.
    if (!g || r.action === 'replace') {
      kept.push(r);
      continue;
    }
    const lead = byGroup.get(g);
    if (!lead) {
      byGroup.set(g, r);
      kept.push(r);
    } else {
      if (!lead.alternatives.includes(r.id)) lead.alternatives.push(r.id);
      suppressed.push({ id: r.id, reason: `alternative to ${lead.id}` });
      folded.push(r);
    }
  }
  const order = { replace: 0, install: 1, consider: 1, 'use-existing': 2 } as const;
  kept.sort((a, b) => order[a.action] - order[b.action] || b.score - a.score || a.id.localeCompare(b.id));
  available.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const limit = opts.limit ?? 10;
  return { recommendations: kept.slice(0, limit), alreadyAvailable: available, suppressed, folded };
}

function evidenceText(r: Reason): string {
  const e = r.evidence[0];
  if (!e) return r.signal;
  if (e.source === 'task') return e.detail.replace(/^task mentions/, 'your task mentions');
  if (e.source === 'git' || e.source === '.') return e.detail;
  // "package.json (package.json)" says the same thing twice.
  const base = e.source.split('/').pop() ?? e.source;
  if (e.detail.toLowerCase() === base.toLowerCase()) return e.source;
  return `${e.detail} (${e.source})`;
}

function whyNow(entry: RegistryEntry, reasons: Reason[], o: { legacyOverlap: string[]; activeOverlap: string[]; partialOverlap: string[]; cliOverlap: string[] }): string {
  const parts: string[] = [];
  if (o.legacyOverlap.length) parts.push(`You still use ${o.legacyOverlap.join(', ')}, which is no longer maintained; this is its replacement.`);
  const seen = new Set<string>();
  const facts: string[] = [];
  for (const r of reasons) {
    if (r.signal === 'configured:legacy') continue;
    const t = evidenceText(r);
    if (seen.has(t)) continue;
    seen.add(t);
    facts.push(t);
    if (facts.length >= 3) break;
  }
  if (facts.length) parts.push(capitalize(facts.join('; ')) + '.');
  if (o.activeOverlap.length) parts.push(`You already have ${o.activeOverlap.join(', ')} for this.`);
  else if (o.partialOverlap.length) parts.push(`${o.partialOverlap.join(', ')} already covers part of this.`);
  else if (o.cliOverlap.length) parts.push(`${o.cliOverlap.join(', ')} already covers part of this from the shell.`);
  if (!parts.length) parts.push(entry.problem);
  return parts.join(' ');
}

function capitalize(s: string): string {
  // File names keep their case: "package.json", not "Package.json".
  if (/^[^\s;]*[./]/.test(s)) return s;
  return s ? s[0]?.toUpperCase() + s.slice(1) : s;
}

export { serverMatchScore };
