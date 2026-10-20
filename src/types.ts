// Shared types. The engine depends on these, never on a concrete host adapter.

export type HostId = 'claude' | 'codex';
export const HOST_IDS: readonly HostId[] = ['claude', 'codex'];

export type EntryKind = 'mcp' | 'plugin' | 'skill' | 'cli';
export type Platform = 'windows' | 'macos' | 'linux';
export type Credibility = 'vendor' | 'foundation' | 'community';
export type EntryStatus = 'active' | 'preview' | 'deprecated' | 'archived' | 'removed' | 'unknown';
export type AccessLevel = 'read' | 'write' | 'admin' | 'exec';
export type AuthType = 'none' | 'oauth' | 'token' | 'connection' | 'cloud' | 'local-app' | 'unknown';
export type Effort = 'low' | 'medium' | 'high';
export type Frequency = 'daily' | 'weekly' | 'occasional';
export type Support = 'yes' | 'no' | 'unknown';

// ---------- project context ----------

export interface Evidence {
  /** Project-relative path (or "git", "task") the evidence came from. */
  source: string;
  /** Short human-readable detail. Never contains secret values. */
  detail: string;
}

export interface Signal {
  id: string;
  /** 0..1, how sure we are that the signal is real. */
  strength: number;
  evidence: Evidence[];
}

export interface GitRemote {
  name: string;
  host: string;
  /** Remote URL with any credentials removed. */
  url: string;
}

export interface GitInfo {
  isRepo: boolean;
  branch?: string;
  remotes: GitRemote[];
  branches: string[];
  recentSubjects: string[];
}

export interface ScanStats {
  filesSeen: number;
  filesRead: number;
  truncated: boolean;
  elapsedMs: number;
}

export interface ProjectContext {
  root: string;
  signals: Record<string, Signal>;
  task?: { text: string; signals: string[] };
  git: GitInfo;
  stats: ScanStats;
  warnings: string[];
}

// ---------- registry ----------

export interface Trigger {
  signal: string;
  /** 0..1, how much this signal alone makes the entry relevant. */
  weight: number;
}

export interface Param {
  name: string;
  description: string;
  example: string;
  /** Used when the user does not pass the parameter. */
  default?: string;
  /** Regex the value must match (anchored); built-in registry only. Defaults to a conservative charset or an https URL. */
  pattern?: string;
  /** Allowed values (an enum); works for custom registries too. */
  values?: string[];
}

/** One concrete way to run an MCP server. Values may contain {param} placeholders. */
export interface ServerSpec {
  transport: 'http' | 'stdio';
  url?: string;
  /** Literal, non-secret headers. */
  headers?: Record<string, string>;
  /** Sends "Authorization: Bearer <value of this env var>". */
  bearerTokenEnv?: string;
  /** Header name -> env var holding the whole header value. */
  envHeaders?: Record<string, string>;
  command?: string;
  args?: string[];
  /** Literal, non-secret environment values (for example READ_ONLY_MODE=true). */
  env?: Record<string, string>;
  /**
   * Secret env vars passed through from the user's environment, never written as values.
   * A trailing '?' marks an optional variable.
   */
  passEnv?: string[];
}

export interface InstallSpec {
  serverName: string;
  /** Least-privilege variant. Used by default when present. */
  readOnly?: ServerSpec;
  /** Full-access variant. */
  write?: ServerSpec;
  params?: Param[];
  /** Executables that must be on PATH for the server to start. */
  requires?: string[];
  /** Per-host differences, for example a URL variant one client needs. */
  overrides?: Partial<Record<HostId, Partial<ServerSpec>>>;
  notes?: string[];
}

export interface HostInfo {
  support: Support;
  /** Plugin id (name@marketplace) when the vendor ships one for this host. */
  plugin?: string;
  /** The vendor's own documented command, shown for reference only. */
  officialCommand?: string;
  notes?: string;
}

export interface MatchRule {
  /** Substrings of a configured server URL. */
  urls?: string[];
  /** Substrings of a configured server command line (package or image name). */
  packages?: string[];
  /** Exact (case-insensitive) configured server names. Weak evidence. */
  names?: string[];
  /** Plugin ids name@marketplace (or bare plugin names). */
  plugins?: string[];
  /** Executables on PATH that provide the same capability. */
  executables?: string[];
  skills?: string[];
}

export interface RegistryEntry {
  id: string;
  name: string;
  kind: EntryKind;
  category: string;
  description: string;
  vendor: string;
  official: boolean;
  credibility: Credibility;
  repo?: string;
  docs: string;
  license?: string;
  status: EntryStatus;
  statusNote?: string;
  successor?: string;
  verifiedAt: string;
  platforms: Platform[];
  provides: string[];
  triggers: Trigger[];
  /** If set, at least one of these signals must be present for the entry to be relevant. */
  requiresAny?: string[];
  problem: string;
  workflow: string;
  benefits: string[];
  access: { level: AccessLevel; summary: string; readOnlyAvailable: boolean };
  auth: { type: AuthType; detail: string };
  network: string;
  setup: { effort: Effort; minutes: number; prerequisites?: string[] };
  value: { timeSaved: 1 | 2 | 3; frequency: Frequency };
  hosts: Record<HostId, HostInfo>;
  install?: InstallSpec;
  /** Guided install text for plugins, skills and CLIs. */
  guide?: string[];
  match: MatchRule;
  limitations: string[];
  securityNotes: string[];
  group?: string;
  alternatives?: string[];
  /** Where the entry came from. Custom entries are treated as community-maintained. */
  origin: 'builtin' | 'custom';
  /** Fields that were missing and filled with conservative defaults. */
  incomplete: string[];
}

export interface Registry {
  version: number;
  updated: string;
  entries: RegistryEntry[];
  warnings: string[];
}

// ---------- inventory of what is already set up ----------

export type ItemScope = 'user' | 'project' | 'local' | 'plugin' | 'managed' | 'system';

export interface ConfiguredServer {
  host: HostId;
  name: string;
  scope: ItemScope;
  source: string;
  transport: 'http' | 'stdio' | 'sse' | 'unknown';
  url?: string;
  command?: string;
  args: string[];
  enabled: boolean;
  viaPlugin?: string;
  /** Claude Code project server that the user has not approved yet. */
  pendingApproval?: boolean;
  /** Why a configured server is not active, when the host says so (e.g. an untrusted Codex project). */
  inactiveReason?: string;
  /** Header and env keys whose values look like literal secrets (values are never kept). */
  inlineSecrets: string[];
  /** env.X / header.X -> value, with anything secret-looking replaced by ***. */
  settings: Record<string, string>;
}

export interface InstalledPlugin {
  host: HostId;
  id: string;
  scope: ItemScope;
  enabled: boolean;
  source: string;
}

export interface InstalledSkill {
  host: HostId;
  name: string;
  scope: ItemScope;
  source: string;
}

export interface ConfigFileState {
  host: HostId;
  kind: string;
  path: string;
  exists: boolean;
  error?: string;
}

export interface Inventory {
  servers: ConfiguredServer[];
  plugins: InstalledPlugin[];
  skills: InstalledSkill[];
  /** Executable name -> resolved path, for the executables we look for. */
  executables: Record<string, string>;
  files: ConfigFileState[];
  hostsDetected: Record<HostId, boolean>;
  hostCli: Partial<Record<HostId, string>>;
  managedMcp?: string;
  warnings: string[];
}

export type AvailabilityState =
  | 'configured'
  | 'disabled'
  | 'cli-available'
  | 'not-configured'
  | 'incompatible'
  | 'unknown';

export interface Availability {
  state: AvailabilityState;
  detail: string;
  servers: ConfiguredServer[];
  plugins: InstalledPlugin[];
  skills: InstalledSkill[];
  executables: string[];
}

// ---------- recommendations ----------

export interface Reason {
  signal: string;
  strength: number;
  weight: number;
  evidence: Evidence[];
}

export interface ScoreBreakdown {
  relevance: number;
  value: number;
  immediacy: number;
  compatibility: number;
  setupCost: number;
  risk: number;
  overlap: number;
}

export type RecommendationAction = 'install' | 'use-existing' | 'replace' | 'consider';

export interface Recommendation {
  id: string;
  entry: RegistryEntry;
  score: number;
  confidence: 'high' | 'medium' | 'low';
  action: RecommendationAction;
  reasons: Reason[];
  whyNow: string;
  breakdown: ScoreBreakdown;
  availability: Partial<Record<HostId, Availability>>;
  uncertainty: string[];
  alternatives: string[];
  /** Signals that appeared since the last scan of this project. */
  newSignals: string[];
}

export type FindingSeverity = 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  severity: FindingSeverity;
  host: HostId;
  code: string;
  message: string;
  fix?: string;
  entryId?: string;
  server?: string;
  source?: string;
}

export type Mode = 'manual' | 'balanced' | 'proactive';
