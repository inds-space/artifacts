export const AGENTS = ["claude", "codex", "antigravity", "chatgpt"] as const;

export type Agent = string;

export const AGENT_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
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

export function isAgent(value: string): boolean {
  return AGENT_PATTERN.test(value);
}

export function isRenderableContentType(value: string): boolean {
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mediaType === "text/html" ||
    mediaType === "text/markdown"
  );
}
