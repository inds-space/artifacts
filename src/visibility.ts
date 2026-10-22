export type Visibility = "private" | "public";

export function parseVisibility(value: unknown): Visibility {
  if (value !== "private" && value !== "public") throw new Error("visibility must be private or public");
  return value;
}

export function artifactUrl(baseUrl: string, row: { agent: string; artifact_type: string; slug: string; visibility: Visibility }): string {
  return `${baseUrl.replace(/\/$/, "")}/${row.visibility === "public" ? "public/" : ""}${row.agent}/${row.artifact_type}/${row.slug}`;
}
