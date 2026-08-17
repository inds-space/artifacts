# Artifacts

Self-hosted, Access-protected publishing for browser-renderable agent artifacts.

Coding agents produce deliverables — plans, reports, diagrams, prototypes — that are awkward to hand back through a terminal. Artifacts gives them a `publish` command and a stable URL you own, instead of scattering work onto someone else's platform.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/inds-space/artifacts)

Canonical URLs look like:

```text
https://artifacts.example.com/<agent>/<artifact-type>/<name>
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

Finally, put a Cloudflare Access application in front of the hostname. Add your own identity for browser access, and issue a **service token** for the CLI. The Worker requires either a `Cf-Access-Jwt-Assertion` header (browser sessions) or valid service-token headers on every request — it has no auth of its own.

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
artifacts publish report.html --agent codex --type report --name weekly-report
artifacts get codex/report/weekly-report
artifacts list --agent codex --type report
artifacts delete codex/report/weekly-report
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
