---
name: artifacts
description: Set up Artifacts for users and publish, retrieve, list, or delete browser-renderable artifacts through MCP or CLI, with private or explicitly public visibility.
---

# Artifacts

Set up and use Artifacts through MCP or CLI. Both are primary interfaces and support the same visibility model.

## Setup

When connecting a user or deploying an instance, read [the setup guide](references/setup.md). Use `artifacts setup --url https://artifacts.<domain>` and `artifacts doctor --json` for CLI configuration and verification. MCP uses the instance `/mcp` endpoint with Cloudflare Access OAuth.

## Workflow

1. Produce the requested artifact as HTML, PDF, Markdown, an image, audio, or video. Prefer self-contained HTML when no format is specified.
2. Choose the current agent namespace: `claude`, `codex`, `antigravity`, `chatgpt`, or a custom lowercase kebab-case agent slug.
3. Choose an existing artifact type. Run `artifacts type list` when uncertain.
4. If the requested type does not exist, add a concise lowercase kebab-case type with `artifacts type add <type>`.
5. Choose a stable lowercase kebab-case name, then publish:

```powershell
artifacts publish <file> --agent codex --type plan --name artifact-cli-proposal
```

For MCP, use `publish_artifact` with `agent`, `type`, `name`, `contentType`, and `content`. Set `visibility: "public"` when public sharing is intended.

6. Return the canonical URL printed by the CLI. Do not expose Cloudflare Access credentials.

## Commands

```powershell
artifacts list --agent codex --type plan
artifacts get codex/plan/artifact-cli-proposal
artifacts get codex/plan/artifact-cli-proposal --download artifact.html
artifacts delete codex/plan/artifact-cli-proposal
artifacts type list
artifacts type add research-brief
```

`artifacts get` returns the canonical URL by default. Use `--json` only when metadata or version history is needed.

## Publishing rules

- Only publish HTML, PDF, Markdown, images, audio, or video. Plain text, CSS, CSV, JSON, archives, executables, and all other formats are rejected.
- New artifacts default to private. To share without Access login, publish with CLI `--public` or `--visibility public`, or MCP `visibility: "public"`. Public URLs are `/public/<agent>/<type>/<name>`.
- Re-publishing preserves visibility when omitted. Use CLI `--private` or MCP `visibility: "private"` to revoke public access immediately.
- Filter by visibility with `artifacts list --visibility public` or MCP `list_artifacts` with `visibility: "public"`.
- Re-publishing the same agent, type, and name creates a new immutable version while keeping the canonical URL stable.
- Deletion immediately removes the canonical route and retains recovery data for 24 hours.
- Treat deletion as destructive: only run it when the user explicitly requests deletion.
- Use the standard types when possible: `plan`, `presentation`, `report`, `spec`, `diagram`, `prototype`, `code-review`, `benchmark`, `screenshot`, `dataset`, `handoff`, `build-output`, `receipt-log`.
- Keep secrets, tokens, private keys, and credentials out of artifacts.
