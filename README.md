# Artifacts

Self-hosted, Access-protected publishing for browser-renderable agent artifacts, with a remote MCP server built in.

Coding agents produce deliverables — plans, reports, diagrams, prototypes — that are awkward to hand back through a terminal. Artifacts gives them a CLI, a standard MCP endpoint, and stable URLs you own instead of scattering work onto someone else's platform.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/inds-space/artifacts)

Canonical URLs look like:

```text
https://artifacts.example.com/<agent>/<artifact-type>/<name>
```

Built-in agent names are `claude`, `codex`, `antigravity`, and `chatgpt`. You can also use any custom lowercase kebab-case agent slug up to 64 characters, such as `gemini`, `local-agent`, or `research-bot`.

The MCP endpoint is:

```text
https://artifacts.example.com/mcp
```

One Cloudflare Worker, D1 for metadata, R2 for objects. Re-publishing creates an immutable version behind a stable canonical URL. Deletes are immediate at the URL and recoverable in storage for 24 hours.

Uploads are restricted to HTML, PDF, Markdown, images, audio, and video. Plain text, CSS, CSV, JSON, archives, executables, and other formats are rejected.

## Self-hosting

You need a Cloudflare account with Workers, D1, R2, and Access.

```bash
pnpm install
wrangler d1 create artifacts-db
wrangler r2 bucket create artifacts-storage
```

Edit `wrangler.jsonc`:

- `routes[0].pattern` — the hostname you will serve from
- `vars.PUBLIC_BASE_URL` — the same hostname, with scheme; canonical URLs are built from it
- `d1_databases[0].database_id` — the id printed by `wrangler d1 create`

Then deploy and apply migrations:

```bash
wrangler deploy
wrangler d1 migrations apply artifacts-db --remote
```

Finally, put a Cloudflare Access application in front of the hostname. Add your own identity for browser and OAuth access, and optionally issue a **service token** for the CLI. The Worker requires an authenticated Access identity on every request and does not implement a separate user database.

## MCP

Artifacts exposes a stateless Streamable HTTP MCP server at `/mcp` with these tools:

- `list_artifacts`
- `get_artifact`
- `publish_artifact`
- `delete_artifact`
- `list_artifact_types`
- `add_artifact_type`

All tools that accept an `agent` use the same open agent-slug schema, so MCP clients can use the built-ins or custom agent names without server changes.

A typical MCP client only needs the URL:

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

For normal remote MCP clients, enable **Managed OAuth** on the Cloudflare Access application protecting your Artifacts hostname.

In Cloudflare Zero Trust:

1. Go to **Access controls → Applications** and edit the application protecting your Artifacts hostname.
2. Open **Advanced settings** and enable **Managed OAuth**.
3. Enable **Dynamic Client Registration**.
4. Enable localhost and loopback redirect URIs for desktop/IDE clients.
5. Add the HTTPS redirect URI patterns required by any hosted MCP clients you want to support.
6. Use a short access-token lifetime and a longer OAuth grant/session lifetime.

Cloudflare Access then handles OAuth discovery, authorization-code + PKCE, refresh tokens, and policy enforcement. The Worker continues to trust the Access identity passed in `Cf-Access-Jwt-Assertion`.

For example, a useful CLI/agent configuration is:

```text
Access token lifetime: 10m
Grant session duration: 336h
Allow localhost clients: yes
Allow loopback clients: yes
```

Do not blindly allow arbitrary hosted redirect URIs. Add only the MCP clients you actually intend to trust.

The MCP server accepts protocol versions `2026-07-28`, `2025-11-25`, `2025-06-18`, and `2025-03-26`.

MCP publishing accepts UTF-8 content directly or binary content as base64. Individual MCP publish payloads are limited to 8 MiB, and inline reads are limited to 256 KiB; larger artifacts should be consumed from their canonical URL.

## CLI

```bash
curl -fsSL https://raw.githubusercontent.com/inds-space/artifacts/main/scripts/install.sh | sh
```

```powershell
irm https://raw.githubusercontent.com/inds-space/artifacts/main/scripts/install.ps1 | iex
```

Point the CLI at your instance and give it the service token:

```bash
export ARTIFACTS_BASE_URL=https://artifacts.example.com
export ARTIFACTS_ACCESS_CLIENT_ID=...
export ARTIFACTS_ACCESS_CLIENT_SECRET=...
```

Or write them to `%APPDATA%\artifacts\config.json` (Windows) / `$XDG_CONFIG_HOME/artifacts/config.json` using the shape in `config.example.json`.

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

`artifacts update` replaces the installed executable with the latest GitHub release. Normal use checks for a new release at most once a day and prints a notice; a failed check never blocks the command you asked for.

## Agent skill

`skills/artifacts/` is a skill definition that teaches an agent when and how to publish. Install it into Claude Code, Codex, and Antigravity with:

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

Local requests need a test `Cf-Access-Jwt-Assertion` header, since there is no Access layer in front of `wrangler dev`.

## Retention

- Current artifact: retained indefinitely.
- Superseded versions: latest 10 retained; versions older than 30 days beyond that set are garbage-collected by the daily cron.
- Deleted artifacts: canonical URL returns 404 immediately; backing versions are hard-deleted after 24 hours.

## License

MIT
