# Set up Artifacts for a user

MCP and CLI are the primary interfaces. Both support public publishing on the same release. Start by checking whether the user already has an instance; reuse its hostname and configuration.

## Connect to an existing instance

For MCP, add the following to the client's MCP server configuration, replacing the hostname:

```json
{"mcpServers":{"artifacts":{"url":"https://artifacts.example.com/mcp"}}}
```

Connect and complete the client's Cloudflare Access OAuth login. No service token belongs in this JSON. Call `list_artifact_types` and verify that `publish_artifact` advertises `visibility` in `tools/list`.

For the CLI, install the current release:

```sh
curl -fsSL https://raw.githubusercontent.com/inds-space/artifacts/main/scripts/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
artifacts setup --url https://artifacts.example.com
```

On Windows:

```powershell
irm https://raw.githubusercontent.com/inds-space/artifacts/main/scripts/install.ps1 | iex
artifacts setup --url https://artifacts.example.com
```

Supply `ARTIFACTS_ACCESS_CLIENT_ID` and `ARTIFACTS_ACCESS_CLIENT_SECRET` through the environment or a private secret-entry mechanism. Do not ask users to paste credentials into chat. `setup` checks authenticated CLI health and MCP public-publishing support before saving configuration. Add `--save-credentials` only when the user wants persistent credentials; the config is written atomically with mode 0600 on POSIX. On Windows, keep the config in the user's private profile and use the profile's ACL protections. Otherwise credentials stay in the environment. Switching instance URLs clears previously stored instance credentials.

For MCP-only setup, `artifacts setup --url https://artifacts.example.com --skip-check` saves the hostname and prints the MCP JSON without requiring service credentials. This explicitly skips verification. Run `artifacts doctor --json` to check the CLI connection later.

Install the bundled agent skill from a checkout:

```sh
sh scripts/install-skill.sh
```

```powershell
pwsh scripts/install-skill.ps1
```

The shell installer accepts destination skill roots as arguments. Honor the user's chosen agent and location; avoid replacing unrelated configuration.

## Create a new instance

Requires a Cloudflare account with Workers, D1, R2, and a hostname on a Cloudflare-managed zone. Use the user's existing Cloudflare tools or authenticated Wrangler session.

1. Clone `https://github.com/inds-space/artifacts`, then run `pnpm install --frozen-lockfile`.
2. Run `pnpm exec wrangler d1 create artifacts-db` and `pnpm exec wrangler r2 bucket create artifacts-storage`.
3. Update `wrangler.jsonc`: set the custom-domain route and `PUBLIC_BASE_URL` to `https://artifacts.<domain>`, and use the returned D1 ID and chosen bucket name. Keep credentials out of this file.
4. Create a Cloudflare Access self-hosted application protecting the entire hostname. Add an Allow policy for the user's identity. Enable Managed OAuth and Dynamic Client Registration for MCP, allowing the redirect patterns required by their MCP clients.
5. For CLI access, create an Access service token and a **Service Auth** policy scoped to that token on the protected hostname. Store the token privately in the user's environment or secret manager. It is shown only once.
6. Create a separate, more specific Access application for `artifacts.<domain>/public/*`, with a **Bypass** policy including **Everyone**. Keep the root application's policies and OAuth settings intact. The Worker permits only GET/HEAD of active artifacts explicitly marked public; API, MCP, metadata, and version history remain authenticated.
7. Run `pnpm run deploy`. It applies D1 migrations before deployment. Direct `wrangler deploy` does not apply migrations.
8. Connect MCP and run CLI `setup` as above. Verify with `artifacts doctor --json`.

## Verify public publishing

Use a clearly synthetic artifact containing no user data. Through MCP call `publish_artifact` with `agent`, `type`, `name`, `contentType`, `content`, and `visibility: "public"`. Through CLI:

```sh
artifacts publish test.html --agent codex --type report --name public-setup-test --public
artifacts list --visibility public --json
artifacts get codex/report/public-setup-test --json
```

Fetch the returned `/public/codex/report/public-setup-test` URL **without cookies, Access headers, or Authorization**. It must return the file with no login redirect. Anonymous `/mcp` and `/api/v1/artifacts` must still require Access. Re-publish with `--private` (or MCP `visibility: "private"`) and verify that the old public URL returns 404. Republishing without a visibility option preserves the current visibility. Existing and newly created artifacts default to private.

Delete the synthetic artifact only when cleanup is authorized. A deleted artifact's public URL must return 404 immediately.
