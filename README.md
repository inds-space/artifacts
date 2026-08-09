# Artifacts

Private, Access-protected publishing for browser-renderable agent artifacts.

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
```

Set `ARTIFACTS_ACCESS_CLIENT_ID` and `ARTIFACTS_ACCESS_CLIENT_SECRET`, or add them to `%APPDATA%\artifacts\config.json` with the shape in `config.example.json`.

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
