// Review of what is already configured: outdated servers, inline secrets, write access where a
// read-only mode exists, duplicates. Pure function over registry + inventory.

import type { ConfiguredServer, Finding, HostId, Inventory, Registry, RegistryEntry, ServerSpec } from '../types.ts';
import { hostLabel, primaryEntryFor } from '../hosts/inventory.ts';
import { displayPath } from '../util/paths.ts';

export function checkConfig(registry: Registry, inv: Inventory, hosts: HostId[]): Finding[] {
  const findings: Finding[] = [];
  const byId = new Map(registry.entries.map((e) => [e.id, e]));

  for (const f of inv.files) {
    if (f.error && hosts.includes(f.host)) {
      findings.push({
        severity: 'high',
        host: f.host,
        code: 'config-unreadable',
        message: `${hostLabel(f.host)} ${f.kind} could not be read: ${f.error}`,
        fix: `Fix the file at ${displayPath(f.path)}; stackhint will not modify a file it cannot parse.`,
        source: f.path,
      });
    }
  }
  if (inv.managedMcp && hosts.includes('claude')) {
    findings.push({
      severity: 'info',
      host: 'claude',
      code: 'managed-mcp',
      message: 'An administrator-managed MCP config is active; Claude Code ignores user and project MCP changes.',
      fix: 'Ask your administrator to add servers to managed-mcp.json.',
      source: inv.managedMcp,
    });
  }

  const capabilityUsers = new Map<string, ConfiguredServer[]>();
  for (const s of inv.servers) {
    if (!hosts.includes(s.host)) continue;
    const where = s.viaPlugin ? `plugin ${s.viaPlugin}` : `${s.scope} scope, ${displayPath(s.source)}`;

    if (s.inlineSecrets.length > 0) {
      const committed = s.scope === 'project';
      findings.push({
        severity: committed ? 'high' : 'medium',
        host: s.host,
        code: 'inline-secret',
        message: `MCP server "${s.name}" (${where}) has what looks like a literal secret in ${s.inlineSecrets.join(', ')}${committed ? '; project config files are usually committed' : ''}.`,
        fix:
          s.host === 'claude'
            ? 'Move the value to an environment variable and reference it as ${VAR} in the config.'
            : 'Move the value to an environment variable and use bearer_token_env_var, env_http_headers or env_vars.',
        server: s.name,
        source: s.source,
      });
    }
    if (s.transport === 'sse') {
      findings.push({
        severity: 'low',
        host: s.host,
        code: 'sse-transport',
        message: `MCP server "${s.name}" uses the SSE transport, which is deprecated in MCP and being shut down by several vendors.`,
        fix: 'Switch to the streamable HTTP endpoint (usually /mcp instead of /sse).',
        server: s.name,
        source: s.source,
      });
    }

    const primary = primaryEntryFor(registry.entries, s);
    if (!primary || primary.score < 100) continue;
    const e = primary.entry;
    if (s.enabled) {
      for (const cap of e.provides) {
        const list = capabilityUsers.get(`${s.host}|${cap}`) ?? [];
        list.push(s);
        capabilityUsers.set(`${s.host}|${cap}`, list);
      }
    }

    if (e.status === 'archived' || e.status === 'removed' || e.status === 'deprecated') {
      const successor = e.successor ? byId.get(e.successor) : undefined;
      findings.push({
        severity: e.status === 'deprecated' ? 'medium' : 'high',
        host: s.host,
        code: `server-${e.status}`,
        message: `MCP server "${s.name}" (${where}) runs ${e.name}, which is ${e.status}${e.statusNote ? `: ${e.statusNote}` : '.'}`,
        ...(successor
          ? { fix: `Replace it with ${successor.name}: stackhint explain ${successor.id}` }
          : { fix: 'Remove it or find a maintained alternative.' }),
        entryId: e.id,
        server: s.name,
        source: s.source,
      });
      for (const note of e.securityNotes) {
        findings.push({ severity: 'high', host: s.host, code: 'security-note', message: `${e.name}: ${note}`, entryId: e.id, server: s.name, source: s.source });
      }
      continue;
    }
    if (e.successor) {
      const successor = byId.get(e.successor);
      if (successor) {
        findings.push({
          severity: 'info',
          host: s.host,
          code: 'successor-available',
          message: `MCP server "${s.name}" runs ${e.name}; the vendor recommends ${successor.name} instead.`,
          fix: `stackhint explain ${successor.id}`,
          entryId: e.id,
          server: s.name,
          source: s.source,
        });
      }
    }
    const ro = e.install?.readOnly;
    const rw = e.install?.write;
    if (ro && rw && !looksReadOnly(s, ro, rw)) {
      findings.push({
        severity: 'low',
        host: s.host,
        code: 'write-access',
        message: `MCP server "${s.name}" (${e.name}) runs with write access, but a read-only mode exists.`,
        fix: `If the agent only needs to read, use the read-only variant: stackhint install ${e.id} --host ${s.host} --dry-run`,
        entryId: e.id,
        server: s.name,
        source: s.source,
      });
    }
  }

  // Same capability configured more than once on the same host.
  for (const [key, list] of capabilityUsers) {
    const names = [...new Set(list.map((s) => s.name))];
    if (names.length < 2) continue;
    const [host, cap] = key.split('|') as [HostId, string];
    findings.push({
      severity: 'low',
      host,
      code: 'duplicate-capability',
      message: `${hostLabel(host)} has ${names.length} servers for "${cap}": ${names.join(', ')}. The agent sees overlapping tools.`,
      fix: 'Keep the one you use and remove the others.',
    });
  }

  // The same server name in several Claude scopes: precedence surprises.
  const byName = new Map<string, ConfiguredServer[]>();
  for (const s of inv.servers) {
    if (s.host !== 'claude' || s.viaPlugin || !hosts.includes('claude')) continue;
    const list = byName.get(s.name) ?? [];
    list.push(s);
    byName.set(s.name, list);
  }
  for (const [name, list] of byName) {
    const scopes = [...new Set(list.map((s) => s.scope))];
    if (scopes.length < 2) continue;
    findings.push({
      severity: 'info',
      host: 'claude',
      code: 'shadowed-server',
      message: `"${name}" is defined in ${scopes.join(', ')} scopes; Claude Code uses local over project over user, so only one of them is active.`,
      server: name,
    });
  }

  const order = { high: 0, medium: 1, low: 2, info: 3 } as const;
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** Does a configured server carry the markers that distinguish the read-only variant? */
export function looksReadOnly(s: ConfiguredServer, ro: ServerSpec, rw: ServerSpec): boolean {
  // Vendors spell read-only in a few common ways; any of them counts.
  if (s.url && /\/readonly(\/|\?|$)|[?&](read_?only|readonly)=(true|1)/i.test(s.url)) return true;
  // Docker's own --read-only is about the container filesystem, not the server's access.
  const viaContainer = /(^|[\\/])(docker|podman|nerdctl)(\.exe)?$/i.test(s.command ?? '');
  if (!viaContainer && s.args.some((a) => /^--?(read-?only|readonly|disable-write)$|^--access-mode=restricted$/i.test(a))) return true;
  if (Object.entries(s.settings).some(([k, v]) => /read_?only/i.test(k) && /^(true|1)$/i.test(v))) return true;
  if (ro.url && rw.url && ro.url !== rw.url) {
    const marker = ro.url.replace(rw.url, '');
    return Boolean(s.url && marker && s.url.includes(marker.replace(/^[?&]/, '')));
  }
  const roArgs = (ro.args ?? []).filter((a) => !(rw.args ?? []).includes(a));
  if (roArgs.some((a) => s.args.includes(a))) return true;
  for (const [k, v] of Object.entries(ro.env ?? {})) {
    if (rw.env?.[k] !== v && s.settings[`env.${k}`] === v) return true;
  }
  for (const [k, v] of Object.entries(ro.headers ?? {})) {
    if (rw.headers?.[k] !== v && Object.entries(s.settings).some(([sk, sv]) => sk.toLowerCase() === `header.${k}`.toLowerCase() && sv === v)) return true;
  }
  return roArgs.length === 0 && Object.keys(ro.env ?? {}).length === 0 && Object.keys(ro.headers ?? {}).length === 0;
}

export type { RegistryEntry };
