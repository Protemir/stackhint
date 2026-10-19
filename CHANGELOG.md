# Changelog

## 0.1.0 (2026-10-20)

First release.

- Project analyzer for .NET, Node, Python, Go, Rust, JVM, PHP and Ruby manifests, compose files, Kubernetes/Helm/Argo CD/Flux, Terraform and cloud configs, CI providers, API files, test configs, README links, git remotes and commit history.
- Curated registry of 68 entries (51 recommendable, 17 legacy for replacement hints), checked against vendor sources in October 2026.
- Reads existing setup for Claude Code (user/local/project scopes, plugins, skills, managed config) and Codex (user/project config, plugins, skills).
- Ranking with evidence, confidence and an explained score; duplicates and equivalent tools are not suggested again.
- `check` review: archived/deprecated servers, secrets written into config, SSE transport, write access where read-only exists, duplicates, shadowed names.
- Approval-based install with plan, diff, backup, validation, `--dry-run` and `rollback`; read-only variants by default; secrets only by env var name.
- `try` for one-session use without config changes.
- Claude Code and Codex plugin (skill + SessionStart/UserPromptSubmit hooks) with manual, balanced and proactive modes.
- Read-only MCP server (`stackhint mcp`).
- Opt-in search of the official MCP Registry with caching.
