---
name: artifacts
description: Create, publish, retrieve, list, and delete private browser-renderable artifacts with the artifacts CLI. Use whenever a user asks to upload or share a plan, presentation, report, spec, diagram, prototype, code review, benchmark, screenshot, dataset, handoff, build output, receipt log, HTML, PDF, image, audio, video, or another browser-renderable result at artifacts.inds.space.
---

# Artifacts

Publish finished browser-renderable deliverables to the private Artifacts service and return the canonical URL.

## Workflow

1. Produce the requested artifact as a browser-renderable file. Prefer a self-contained HTML file when no format is specified.
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

- Only publish content browsers can render directly. Do not publish archives, executables, or opaque binary blobs.
- Re-publishing the same agent, type, and name creates a new immutable version while keeping the canonical URL stable.
- Deletion immediately removes the canonical route and retains recovery data for 24 hours.
- Treat deletion as destructive: only run it when the user explicitly requests deletion.
- Use the standard types when possible: `plan`, `presentation`, `report`, `spec`, `diagram`, `prototype`, `code-review`, `benchmark`, `screenshot`, `dataset`, `handoff`, `build-output`, `receipt-log`.
- Keep secrets, tokens, private keys, and credentials out of artifacts.
