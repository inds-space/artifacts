import { artifactUrl, parseVisibility, type Visibility } from "./visibility";
import { AGENTS, isAgent, isRenderableContentType, NAME_PATTERN, TYPE_PATTERN, type Agent } from "./constants";
import { json, landing, methodNotAllowed, secureHeaders } from "./http";

type ArtifactRow = {
  id: string;
  agent: Agent;
  artifact_type: string;
  slug: string;
  current_version: number;
  current_object_key: string;
  content_type: string;
  size_bytes: number | null;
  sha256: string;
  visibility: Visibility;
  status: "active" | "deleted";
  deleted_at: string | null;
  delete_after: string | null;
  created_at: string;
  updated_at: string;
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function hasAccessIdentity(request: Request): boolean {
  return Boolean(
    request.headers.get("Cf-Access-Jwt-Assertion")?.trim() ||
      request.headers.get("Cf-Access-Authenticated-User-Email")?.trim(),
  );
}

function decodePath(pathname: string): string[] {
  try {
    return pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new HttpError(400, "Invalid URL encoding");
  }
}

function parseAgent(value: string | null): Agent {
  if (!value || !isAgent(value)) throw new HttpError(400, `Unknown agent. Supported agents: ${AGENTS.join(", ")}`);
  return value;
}

function parseType(value: string | null): string {
  const type = value?.trim().toLowerCase() ?? "";
  if (!TYPE_PATTERN.test(type)) throw new HttpError(400, "Artifact type must be a lowercase kebab-case name up to 32 characters");
  return type;
}

function parseSlug(value: string | null): string {
  const slug = value?.trim().toLowerCase() ?? "";
  if (!NAME_PATTERN.test(slug)) throw new HttpError(400, "Artifact name must be a lowercase kebab-case slug up to 64 characters");
  return slug;
}

function canonicalUrl(env: CloudflareBindings, row: ArtifactRow): string {
  return artifactUrl(env.PUBLIC_BASE_URL, row);
}

function objectKey(id: string, version: number): string {
  return `artifacts/${id}/versions/${String(version)}-${crypto.randomUUID()}`;
}

function artifactJson(row: ArtifactRow, env: CloudflareBindings) {
  return {
    id: row.id,
    agent: row.agent,
    type: row.artifact_type,
    name: row.slug,
    version: row.current_version,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    visibility: row.visibility,
    status: row.status,
    deletedAt: row.deleted_at,
    deleteAfter: row.delete_after,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    url: canonicalUrl(env, row),
  };
}

async function requireKnownType(env: CloudflareBindings, type: string): Promise<void> {
  const row = await env.DB.prepare("SELECT name FROM artifact_types WHERE name = ?").bind(type).first();
  if (!row) throw new HttpError(400, `Unknown artifact type '${type}'. Add it first with: artifacts type add ${type}`);
}

async function getArtifact(env: CloudflareBindings, agent: Agent, type: string, slug: string, includeDeleted = false): Promise<ArtifactRow | null> {
  const status = includeDeleted ? "" : " AND status = 'active'";
  return env.DB.prepare(`SELECT * FROM artifacts WHERE agent = ? AND artifact_type = ? AND slug = ?${status}`)
    .bind(agent, type, slug)
    .first<ArtifactRow>();
}

function parseUpload(request: Request): { contentType: string; sha256: string; sizeBytes: number | null; body: ReadableStream } {
  if (!request.body) throw new HttpError(400, "Upload body is required");
  const contentType = request.headers.get("Content-Type")?.trim() ?? "";
  if (!isRenderableContentType(contentType)) throw new HttpError(415, "Only HTML, PDF, Markdown, image, audio, and video files are accepted");
  const sha256 = request.headers.get("X-Artifact-SHA256")?.trim().toLowerCase() ?? "";
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new HttpError(400, "X-Artifact-SHA256 must be a lowercase SHA-256 hex digest");
  const length = request.headers.get("Content-Length");
  const sizeBytes = length && /^\d+$/.test(length) ? Number(length) : null;
  return { contentType, sha256, sizeBytes, body: request.body };
}

async function handlePublish(request: Request, env: CloudflareBindings): Promise<Response> {
  const url = new URL(request.url);
  const agent = parseAgent(url.searchParams.get("agent"));
  const type = parseType(url.searchParams.get("type"));
  const slug = parseSlug(url.searchParams.get("name"));
  let requestedVisibility: Visibility | undefined;
  if (url.searchParams.has("visibility")) {
    try { requestedVisibility = parseVisibility(url.searchParams.get("visibility")); }
    catch { throw new HttpError(400, "visibility must be private or public"); }
  }
  await requireKnownType(env, type);
  const upload = parseUpload(request);
  const existing = await getArtifact(env, agent, type, slug, true);
  const visibility = requestedVisibility ?? existing?.visibility ?? "private";
  const id = existing?.id ?? `art_${crypto.randomUUID().replaceAll("-", "")}`;
  const version = (existing?.current_version ?? 0) + 1;
  const key = objectKey(id, version);
  const now = new Date().toISOString();

  await env.STORAGE.put(key, upload.body, {
    httpMetadata: { contentType: upload.contentType },
    customMetadata: { artifactId: id, agent, type, slug, version: String(version), sha256: upload.sha256 },
    sha256: upload.sha256,
  });

  try {
    if (!existing) {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO artifacts (id, agent, artifact_type, slug, current_version, current_object_key, content_type, size_bytes, sha256, visibility, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)")
          .bind(id, agent, type, slug, version, key, upload.contentType, upload.sizeBytes, upload.sha256, visibility, now, now),
        env.DB.prepare("INSERT INTO artifact_versions (artifact_id, version, object_key, content_type, size_bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(id, version, key, upload.contentType, upload.sizeBytes, upload.sha256, now),
      ]);
    } else {
      const results = await env.DB.batch([
        env.DB.prepare("UPDATE artifacts SET current_version = ?, current_object_key = ?, content_type = ?, size_bytes = ?, sha256 = ?, status = 'active', deleted_at = NULL, delete_after = NULL, updated_at = ?, visibility = ? WHERE id = ? AND current_version = ?")
          .bind(version, key, upload.contentType, upload.sizeBytes, upload.sha256, now, visibility, id, existing.current_version),
        env.DB.prepare("INSERT INTO artifact_versions (artifact_id, version, object_key, content_type, size_bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(id, version, key, upload.contentType, upload.sizeBytes, upload.sha256, now),
      ]);
      if ((results[0]?.meta.changes ?? 0) !== 1) throw new HttpError(409, "Artifact changed during publish; retry the command");
    }
  } catch (error) {
    await env.STORAGE.delete(key);
    throw error;
  }

  const row = await getArtifact(env, agent, type, slug);
  if (!row) throw new Error("Published artifact could not be reloaded");
  return json({ artifact: artifactJson(row, env) }, { status: existing ? 200 : 201 });
}

async function handleList(url: URL, env: CloudflareBindings): Promise<Response> {
  const clauses = ["status = 'active'"];
  const values: string[] = [];
  const agentValue = url.searchParams.get("agent");
  if (agentValue) {
    clauses.push("agent = ?");
    values.push(parseAgent(agentValue));
  }
  const typeValue = url.searchParams.get("type");
  if (typeValue) {
    clauses.push("artifact_type = ?");
    values.push(parseType(typeValue));
  }
  if (url.searchParams.has("visibility")) {
    try { values.push(parseVisibility(url.searchParams.get("visibility"))); }
    catch { throw new HttpError(400, "visibility must be private or public"); }
    clauses.push("visibility = ?");
  }
  const query = `SELECT * FROM artifacts WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT 500`;
  const result = await env.DB.prepare(query).bind(...values).all<ArtifactRow>();
  return json({ artifacts: result.results.map((row) => artifactJson(row, env)) });
}

async function handleMetadata(env: CloudflareBindings, agent: Agent, type: string, slug: string): Promise<Response> {
  const row = await getArtifact(env, agent, type, slug);
  if (!row) throw new HttpError(404, "Artifact not found");
  const versions = await env.DB.prepare("SELECT version, content_type AS contentType, size_bytes AS sizeBytes, sha256, created_at AS createdAt FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC")
    .bind(row.id).all();
  return json({ artifact: artifactJson(row, env), versions: versions.results });
}

async function handleDelete(env: CloudflareBindings, agent: Agent, type: string, slug: string): Promise<Response> {
  const row = await getArtifact(env, agent, type, slug);
  if (!row) throw new HttpError(404, "Artifact not found");
  const deletedAt = new Date();
  const deleteAfter = new Date(deletedAt.getTime() + 86_400_000);
  await env.DB.prepare("UPDATE artifacts SET status = 'deleted', deleted_at = ?, delete_after = ?, updated_at = ? WHERE id = ? AND status = 'active'")
    .bind(deletedAt.toISOString(), deleteAfter.toISOString(), deletedAt.toISOString(), row.id).run();
  return json({ deleted: true, recoverableUntil: deleteAfter.toISOString(), url: canonicalUrl(env, row) });
}

async function handleTypes(request: Request, env: CloudflareBindings): Promise<Response> {
  if (request.method === "GET") {
    const result = await env.DB.prepare("SELECT name, created_at AS createdAt FROM artifact_types ORDER BY name").all();
    return json({ types: result.results });
  }
  if (request.method === "POST") {
    const type = parseType(new URL(request.url).searchParams.get("name"));
    const result = await env.DB.prepare("INSERT OR IGNORE INTO artifact_types (name, created_at) VALUES (?, ?)").bind(type, new Date().toISOString()).run();
    return json({ type, created: result.meta.changes === 1 }, { status: result.meta.changes === 1 ? 201 : 200 });
  }
  return methodNotAllowed(["GET", "POST"]);
}

async function serveArtifact(request: Request, env: CloudflareBindings, agent: Agent, type: string, slug: string, publicOnly = false): Promise<Response> {
  const row = await getArtifact(env, agent, type, slug);
  if (!row || (publicOnly && row.visibility !== "public")) throw new HttpError(404, "Artifact not found");
  const etag = `"${row.sha256}"`;
  if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-store, no-transform" } });
  const object = await env.STORAGE.get(row.current_object_key);
  if (!object) throw new HttpError(404, "Artifact object missing");
  const headers = secureHeaders();
  headers.set("Content-Type", row.content_type);
  headers.set("Content-Disposition", "inline");
  headers.set("Cache-Control", "no-store, no-transform");
  headers.set("ETag", etag);
  headers.set("X-Artifact-Version", String(row.current_version));
  headers.set("X-Artifact-Type", row.artifact_type);
  headers.set("Content-Security-Policy", "default-src 'none'; base-uri 'none'; connect-src 'none'; font-src data:; form-action 'none'; frame-ancestors 'none'; img-src data: blob:; media-src data: blob:; script-src 'unsafe-inline'; style-src 'unsafe-inline'");
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

function landingPage(env: CloudflareBindings): Response {
  return landing(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Artifacts</title><style>body{font:16px/1.55 system-ui;max-width:760px;margin:10vh auto;padding:0 24px;background:#0b0d10;color:#f4f6f8}code{color:#9ee6b8}</style><h1>Artifacts</h1><p>Private browser-renderable artifacts for <code>${AGENTS.join("</code>, <code>")}</code>.</p><p>Canonical URLs: <code>${env.PUBLIC_BASE_URL}/&lt;agent&gt;/&lt;type&gt;/&lt;name&gt;</code></p></html>`);
}

async function route(request: Request, env: CloudflareBindings): Promise<Response> {
  const url = new URL(request.url);
  const segments = decodePath(url.pathname);
  // Only this exact content route bypasses Access. Never expose API, MCP, or history.
  if (url.pathname.startsWith("/public/")) {
    if (segments.length !== 4 || segments[0] !== "public") throw new HttpError(404, "Not found");
    const agent = parseAgent(segments[1] ?? null);
    const type = parseType(segments[2] ?? null);
    const slug = parseSlug(segments[3] ?? null);
    return request.method === "GET" || request.method === "HEAD"
      ? serveArtifact(request, env, agent, type, slug, true)
      : methodNotAllowed(["GET", "HEAD"]);
  }
  if (!hasAccessIdentity(request)) return json({ error: "Cloudflare Access authentication required" }, { status: 401 });
  if (segments.length === 0) return request.method === "GET" ? landingPage(env) : methodNotAllowed(["GET"]);
  if (segments.join("/") === "api/v1/health") return request.method === "GET" ? json({ ok: true, service: "artifacts" }) : methodNotAllowed(["GET"]);
  if (segments.join("/") === "api/v1/types") return handleTypes(request, env);
  if (segments.join("/") === "api/v1/artifacts") {
    if (request.method === "GET") return handleList(url, env);
    if (request.method === "POST") return handlePublish(request, env);
    return methodNotAllowed(["GET", "POST"]);
  }
  if (segments.length === 6 && segments.slice(0, 3).join("/") === "api/v1/artifacts") {
    const agent = parseAgent(segments[3] ?? null);
    const type = parseType(segments[4] ?? null);
    const slug = parseSlug(segments[5] ?? null);
    if (request.method === "GET") return handleMetadata(env, agent, type, slug);
    if (request.method === "DELETE") return handleDelete(env, agent, type, slug);
    return methodNotAllowed(["GET", "DELETE"]);
  }
  if (segments.length === 3) {
    const agent = parseAgent(segments[0] ?? null);
    const type = parseType(segments[1] ?? null);
    const slug = parseSlug(segments[2] ?? null);
    return request.method === "GET" || request.method === "HEAD" ? serveArtifact(request, env, agent, type, slug) : methodNotAllowed(["GET", "HEAD"]);
  }
  throw new HttpError(404, "Not found");
}

async function garbageCollect(env: CloudflareBindings): Promise<void> {
  const expired = await env.DB.prepare("SELECT id FROM artifacts WHERE status = 'deleted' AND delete_after <= ? LIMIT 100").bind(new Date().toISOString()).all<{ id: string }>();
  for (const artifact of expired.results) {
    const versions = await env.DB.prepare("SELECT object_key FROM artifact_versions WHERE artifact_id = ?").bind(artifact.id).all<{ object_key: string }>();
    if (versions.results.length) await env.STORAGE.delete(versions.results.map((row) => row.object_key));
    await env.DB.prepare("DELETE FROM artifacts WHERE id = ? AND status = 'deleted'").bind(artifact.id).run();
  }
  const stale = await env.DB.prepare("SELECT object_key FROM (SELECT object_key, created_at, ROW_NUMBER() OVER (PARTITION BY artifact_id ORDER BY version DESC) AS rank FROM artifact_versions) WHERE rank > 10 AND created_at < datetime('now', '-30 days') LIMIT 500").all<{ object_key: string }>();
  if (stale.results.length) {
    await env.STORAGE.delete(stale.results.map((row) => row.object_key));
    for (const row of stale.results) await env.DB.prepare("DELETE FROM artifact_versions WHERE object_key = ?").bind(row.object_key).run();
  }
}

export default {
  async fetch(request: Request, env: CloudflareBindings, _ctx: ExecutionContext): Promise<Response> {
    void _ctx;
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, { status: error.status });
      console.error("Unhandled artifacts error", error);
      return json({ error: "Internal server error" }, { status: 500 });
    }
  },
  scheduled(_controller: ScheduledController, env: CloudflareBindings, ctx: ExecutionContext): void {
    void _controller;
    ctx.waitUntil(garbageCollect(env));
  },
} satisfies ExportedHandler<CloudflareBindings>;
