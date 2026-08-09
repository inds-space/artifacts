export const AGENTS = ["claude", "codex", "antigravity"] as const;

export type Agent = (typeof AGENTS)[number];

export const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const TYPE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export const DEFAULT_TYPES = [
  "plan",
  "presentation",
  "report",
  "spec",
  "diagram",
  "prototype",
  "code-review",
  "benchmark",
  "screenshot",
  "dataset",
  "handoff",
  "build-output",
  "receipt-log",
] as const;

export function isAgent(value: string): value is Agent {
  return (AGENTS as readonly string[]).includes(value);
}

export function isRenderableContentType(value: string): boolean {
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mediaType.startsWith("text/") ||
    mediaType.startsWith("image/") ||
    mediaType.startsWith("audio/") ||
    mediaType.startsWith("video/") ||
    [
      "application/javascript",
      "application/json",
      "application/ld+json",
      "application/pdf",
      "application/xhtml+xml",
      "application/xml",
      "application/wasm",
    ].includes(mediaType)
  );
}
