---
name: artifacts
description: Create, publish, retrieve, list, and delete private artifacts with the artifacts CLI. Use whenever a user asks to upload or share a plan, presentation, report, spec, diagram, prototype, code review, benchmark, screenshot, dataset, handoff, build output, receipt log, HTML, PDF, Markdown, image, audio, or video on the configured Artifacts instance.
---

# Artifacts

Publish finished browser-renderable deliverables to the private Artifacts service and return the canonical URL.

## Workflow

1. Produce the requested artifact as HTML, PDF, Markdown, an image, audio, or video. Prefer self-contained HTML when no format is specified.
2. Choose exactly one agent namespace: `claude`, `codex`, or `antigravity`.
3. Choose an existing artifact type. Run `artifacts type list` when uncertain.
4. If the requested type does not exist, add a concise lowercase kebab-case type with `artifacts type add <type>`.
5. Choose a stable lowercase kebab-case name, then publish:

```powershell
artifacts publish <file> --agent codex --type plan --name artifact-cli-proposal
```

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
- Re-publishing the same agent, type, and name creates a new immutable version while keeping the canonical URL stable.
- Deletion immediately removes the canonical route and retains recovery data for 24 hours.
- Treat deletion as destructive: only run it when the user explicitly requests deletion.
- Use the standard types when possible: `plan`, `presentation`, `report`, `spec`, `diagram`, `prototype`, `code-review`, `benchmark`, `screenshot`, `dataset`, `handoff`, `build-output`, `receipt-log`.
- Keep secrets, tokens, private keys, and credentials out of artifacts.
