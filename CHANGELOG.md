# Changelog

## 0.2.0 (2026-10-20)

A bug-hunting pass over 0.1.0 (three independent reviews, 34 confirmed findings, each with a regression test) and a registry twice as large.

Installs and config files
- Config files keep their exact bytes: files that are not valid UTF-8 are refused instead of corrupted, a BOM and CRLF line endings are kept, and rollback restores the original byte for byte.
- A `~/.codex/config.toml` that is a symlink or hard link (dotfile managers) is written through instead of being replaced by a plain file.
- `.mcp.json` gets the new server inserted into the text; big numbers, key order and odd keys elsewhere stay untouched.
- A failed write no longer leaves a backup listed as an install; rollback removes a folder the install created (say `~/.codex`).
- Project-scope installs on Windows warn that `cmd /c npx` will not start for macOS and Linux teammates.
- `try --host codex` prints arguments that survive Windows PowerShell 5.1.
- `setup` writes the skill next to the config it uses; quoted PATH entries are found.

Recommendations
- A replacement for a retired server you still use is never folded away behind another entry of its group.
- Hosted Neon or Supabase servers no longer count as a tool for any Postgres.
- Servers behind `mcp-remote` are recognised; `docs.mcp.cloudflare.com` no longer counts as the Cloudflare API server.
- Example and fixture folders cannot open a tool's gate on their own; confidence now weighs how much a signal matters for the tool.
- Projects that already have their own skills are not told to write one.
- Fewer false positives from task text ("a zebra stripe", "Mr. Smith", "confluence of rivers", "linear colour").

Detection
- Secrets from `.vscode/mcp.json` and `.cursor/mcp.json` arguments can no longer end up in signal ids.
- Breadth-first scan with media files outside the file limit, Python virtualenvs under any name skipped, a time limit for reading files (hooks stay fast), and PATH lookups about 15 times faster.
- New: browser extensions, browser games, static pages, `node --test`, .NET Aspire packages, Gradle catalogs, compose image defaults, bitnami images, UTF-16 requirements, uv and PDM dev dependencies, SSH host aliases; Go indirect requirements, Dependabot bumps and `STEP-1` style words no longer count.
- About 50 new signals for the new registry entries (frameworks, hosting, observability, data services, trackers).

Registry: 143 entries (was 68)
- MCP servers for Next.js, Angular, Svelte, Nuxt, Astro, Nx, Storybook, shadcn/ui, Shopify, Expo, Prisma, Hugging Face, Dart and Flutter, Xcode, Unity, Unreal, Develocity, Laravel Boost.
- Hosting and services: Netlify, Heroku, Render, Railway, Fly.io, Pulumi, DigitalOcean, PlanetScale, Turso, Upstash, Algolia, Contentful, Sanity, Slack, Auth0, Clerk, Twilio docs, Resend, Asana, monday.com, ClickUp, Datadog, New Relic, Honeycomb, PagerDuty, Dynatrace, PostHog, Elastic Agent Builder.
- Plugins: all 13 official LSP plugins, Claude security review, security guidance, frontend design, PR review toolkit, commit commands, CLAUDE.md management, Agent SDK, MCP server and plugin development, Expo, Unity, Redis and ClickHouse skills, Codex Security.
- Codex's curated plugins for GitHub, Linear, Supabase, Cloudflare, Vercel, Stripe, Sentry, Notion and Figma count as set up.

CLI and MCP server
- The MCP server answers `null`, empty batches and bad ids with errors instead of exiting, returns batches as one array, and never runs a request sent as a notification.
- `dismiss --project` works from any subfolder; state writes are locked so parallel sessions do not lose each other's changes, and a hand-edited state file no longer breaks commands.
- Every command supports `--format json`; unknown formats, extra arguments and missing folders are errors.
- Snooze times are shown in local time; expired snoozes are not listed.
- Printed install commands include the project path when one was given; hook hints work for people who installed only the plugin.

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
