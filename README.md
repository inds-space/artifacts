# Artifacts

Self-hosted, Access-protected publishing for browser-renderable agent artifacts, with **MCP and CLI as first-class interfaces**.

Coding agents produce plans, reports, diagrams, prototypes, and other deliverables that are awkward to hand back through a terminal. Artifacts gives them a standard remote MCP server, a CLI, and stable URLs you own.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/inds-space/artifacts)

Canonical URLs:

```text
https://artifacts.example.com/<agent>/<artifact-type>/<name>
```

MCP endpoint:

```text
https://artifacts.example.com/mcp
```

Built-in agents are `claude`, `codex`, `antigravity`, and `chatgpt`. Any lowercase kebab-case custom agent slug up to 64 characters is also supported, such as `gemini`, `local-agent`, or `research-bot`.

One Cloudflare Worker serves the REST API, canonical artifact URLs, and MCP endpoint. D1 stores metadata and R2 stores immutable artifact versions. Re-publishing creates a new version behind the same canonical URL; deletes are immediate at the URL and recoverable in storage for 24 hours.

Uploads are restricted to HTML, PDF, Markdown, images, audio, and video.

## MCP

MCP is a primary interface to Artifacts, not a wrapper around the CLI. The Worker exposes a stateless Streamable HTTP server at `/mcp` with native tools for the complete artifact workflow:

- `list_artifacts`
- `get_artifact`
- `publish_artifact`
- `delete_artifact`
- `list_artifact_types`
- `add_artifact_type`

All tools that accept an `agent` support both built-in and custom agent names.

A typical MCP client only needs the endpoint:

```json
{
  "mcpServers": {
    "artifacts": {
      "url": "https://artifacts.example.com/mcp"
    }
  }
}
```

### OAuth with Cloudflare Access

For remote MCP clients, enable **Managed OAuth** on the Cloudflare Access application protecting the Artifacts hostname and enable **Dynamic Client Registration**.

For broad native/desktop compatibility, allow localhost and loopback redirect URIs. For hosted clients, add only the HTTPS redirect URI patterns for clients you intend to trust.

A practical configuration is:

```text
Access token lifetime: 10m
Grant session duration: 336h
Allow localhost clients: yes
Allow loopback clients: yes
```

Cloudflare Access handles OAuth discovery, authorization-code + PKCE, refresh tokens, and Access policy enforcement. The Worker trusts the authenticated Access identity passed by Cloudflare.

The MCP server accepts protocol versions `2026-07-28`, `2025-11-25`, `2025-06-18`, and `2025-03-26`.

MCP publishing accepts UTF-8 content directly or binary content as base64. Publish payloads are limited to 8 MiB and inline reads to 256 KiB; larger artifacts should be consumed through their canonical URL.

## CLI

The CLI exposes the same artifact model for shell scripts and agents that prefer command execution.

```bash
curl -fsSL https://raw.githubusercontent.com/inds-space/artifacts/main/scripts/install.sh | sh
```

```powershell
irm https://raw.githubusercontent.com/inds-space/artifacts/main/scripts/install.ps1 | iex
```

Point it at your instance and provide a Cloudflare Access service token:

```bash
export ARTIFACTS_BASE_URL=https://artifacts.example.com
export ARTIFACTS_ACCESS_CLIENT_ID=...
export ARTIFACTS_ACCESS_CLIENT_SECRET=...
```

Examples:

```bash
artifacts publish report.html --agent chatgpt --type report --name weekly-report
artifacts publish notes.md --agent my-local-agent --type report --name research-notes
artifacts get chatgpt/report/weekly-report
artifacts list --agent my-local-agent --type report
artifacts delete chatgpt/report/weekly-report
artifacts type list
artifacts type add research-brief
artifacts update
```

## Self-hosting

You need Cloudflare Workers, D1, R2, and Access.

```bash
pnpm install
wrangler d1 create artifacts-db
wrangler r2 bucket create artifacts-storage
```

Edit `wrangler.jsonc` with your hostname, `PUBLIC_BASE_URL`, and D1 database ID, then deploy and apply migrations:

```bash
wrangler deploy
wrangler d1 migrations apply artifacts-db --remote
```

Put a Cloudflare Access application in front of the hostname. Add your identity for browser/OAuth access and optionally a service token for the CLI.

## Agent skill

`skills/artifacts/` teaches agents when and how to publish artifacts.

```powershell
pwsh scripts/install-skill.ps1
```

## Development

```bash
pnpm install
pnpm run types
pnpm run check
pnpm run lint
pnpm test
pnpm run build
```

Local requests need a test `Cf-Access-Jwt-Assertion` header because there is no Access layer in front of `wrangler dev`.

## Retention

- Current artifact: retained indefinitely.
- Superseded versions: latest 10 retained; versions older than 30 days beyond that set are garbage-collected by the daily cron.
- Deleted artifacts: canonical URL returns 404 immediately; backing versions are hard-deleted after 24 hours.

## License

MIT
