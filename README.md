# Artifacts

Private, Access-protected publishing for browser-renderable agent artifacts.

Uploads are restricted to HTML, PDF, Markdown, images, audio, and video. Plain text, CSS, CSV, JSON, archives, executables, and other formats are rejected.

Canonical URLs use:

```text
https://artifacts.inds.space/<agent>/<artifact-type>/<name>
```

The platform is one Cloudflare Worker with D1 metadata and R2 object storage. Re-publishing creates immutable versions behind a stable canonical URL. Delete is immediate at the URL and recoverable in storage for 24 hours.

## CLI

```powershell
artifacts publish report.html --agent codex --type report --name weekly-report
artifacts get codex/report/weekly-report
artifacts list --agent codex --type report
artifacts delete codex/report/weekly-report
artifacts type list
artifacts type add research-brief
artifacts update
```

Set `ARTIFACTS_ACCESS_CLIENT_ID` and `ARTIFACTS_ACCESS_CLIENT_SECRET`, or add them to `%APPDATA%\artifacts\config.json` with the shape in `config.example.json`.

Private CLI releases are installed and updated through an authenticated GitHub CLI session (`gh auth login`). `artifacts update` downloads the latest private release and replaces the installed executable. Normal CLI use checks GitHub at most once every 24 hours and prints a notice when an update is available; a failed check never blocks the requested command.

## Development

```powershell
pnpm install
pnpm run types
pnpm run check
pnpm run lint
pnpm test
pnpm run build
```

For local requests, include a test `Cf-Access-Jwt-Assertion` header. Production is protected by Cloudflare Access for both owner browser sessions and the CLI service token.

## Retention

- Current artifact: retained indefinitely.
- Superseded versions: latest 10 retained; versions older than 30 days beyond that set are garbage-collected.
- Deleted artifacts: canonical URL returns 404 immediately; backing versions are hard-deleted after 24 hours.
