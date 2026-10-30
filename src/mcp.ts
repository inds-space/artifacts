import { remoteImageWarnings } from "./html-warnings";
import { artifactUrl, parseVisibility, type Visibility } from "./visibility";
import { AGENTS, AGENT_PATTERN, isAgent, isRenderableContentType, NAME_PATTERN, TYPE_PATTERN, type Agent } from "./constants";

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

type JsonRpcId = string | number | null;
type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const SERVER_NAME = "inds-space-artifacts";
const SERVER_VERSION = "0.5.0";
const LATEST_PROTOCOL_VERSION = "2026-07-28";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
]);
const MAX_PUBLISH_BYTES = 8 * 1024 * 1024;
const MAX_INLINE_TEXT_BYTES = 256 * 1024;
const AGENT_SCHEMA = {
  type: "string",
  pattern: AGENT_PATTERN.source,
  description: `Lowercase kebab-case agent slug. Built-ins: ${AGENTS.join(", ")}. Custom agent names are supported.`,
};

const TOOLS: ToolDefinition[] = [
  {
    name: "list_artifacts",
    description: "List active artifacts, optionally filtered by agent or artifact type.",
    inputSchema: {
      type: "object",
      properties: {
        agent: AGENT_SCHEMA,
        type: { type: "string", description: "Artifact type, for example plan or report." },
        visibility: { type: "string", enum: ["private", "public"], description: "Filter by visibility." },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_artifact",
    description: "Get artifact metadata and version history. Content can optionally be returned inline when small enough.",
    inputSchema: {
      type: "object",
      properties: {
        agent: AGENT_SCHEMA,
        type: { type: "string" },
        name: { type: "string", pattern: NAME_PATTERN.source, description: "Extensionless lowercase kebab-case name; do not append .html or .md." },
        includeContent: { type: "boolean", default: false },
      },
      required: ["agent", "type", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "publish_artifact",
    description: "Create or replace an artifact. Set visibility to public for an unauthenticated /public/<agent>/<type>/<name> URL, or private to revoke public access. New artifacts default to private; replacements preserve visibility when omitted. Content may be UTF-8 or base64; SHA-256 is computed automatically. HTML is served with a CSP that only allows data: and blob: images, so embed images as data: URLs; remote image URLs are reported in warnings.",
    inputSchema: {
      type: "object",
      properties: {
        agent: AGENT_SCHEMA,
        type: { type: "string" },
        name: { type: "string", pattern: NAME_PATTERN.source, description: "Extensionless lowercase kebab-case name; do not append .html or .md." },
        contentType: { type: "string", description: "Only text/markdown or text/html, optionally with charset=utf-8. Publish other file formats to your CDN." },
        content: { type: "string" },
        visibility: { type: "string", enum: ["private", "public"], description: "New artifacts default to private. Omit on replacement to preserve visibility; public allows anyone with the URL to read the content." },
        encoding: { type: "string", enum: ["utf8", "base64"], default: "utf8" },
      },
      required: ["agent", "type", "name", "contentType", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_artifact",
    description: "Soft-delete an artifact. It remains recoverable by the service for 24 hours before garbage collection.",
    inputSchema: {
      type: "object",
      properties: {
        agent: AGENT_SCHEMA,
        type: { type: "string" },
        name: { type: "string", pattern: NAME_PATTERN.source, description: "Extensionless lowercase kebab-case name; do not append .html or .md." },
      },
      required: ["agent", "type", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "list_artifact_types",
    description: "List registered artifact types.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "add_artifact_type",
    description: "Register a new artifact type using a lowercase kebab-case name.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
];

class McpToolError extends Error {}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpToolError("Tool arguments must be an object");
  return value as Record<string, unknown>;
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new McpToolError(`${name} is required`);
  return value.trim();
}

function optionalBoolean(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new McpToolError(`${name} must be a boolean`);
  return value;
}

function parseAgent(value: string): Agent {
  const agent = value.trim().toLowerCase();
  if (!isAgent(agent)) throw new McpToolError("Agent must be a lowercase kebab-case slug up to 64 characters");
  return agent;
}

function parseType(value: string): string {
  const type = value.trim().toLowerCase();
  if (!TYPE_PATTERN.test(type)) throw new McpToolError("Artifact type must be a lowercase kebab-case name up to 32 characters");
  return type;
}

function parseSlug(value: string): string {
  const slug = value.trim().toLowerCase();
  if (!NAME_PATTERN.test(slug)) throw new McpToolError("Artifact name must be a lowercase kebab-case slug up to 64 characters");
  return slug;
}

function canonicalUrl(env: CloudflareBindings, row: ArtifactRow): string {
  return artifactUrl(env.PUBLIC_BASE_URL, row);
}

function artifactJson(env: CloudflareBindings, row: ArtifactRow) {
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

async function getArtifact(env: CloudflareBindings, agent: Agent, type: string, slug: string, includeDeleted = false): Promise<ArtifactRow | null> {
  const status = includeDeleted ? "" : " AND status = 'active'";
  return env.DB.prepare(`SELECT * FROM artifacts WHERE agent = ? AND artifact_type = ? AND slug = ?${status}`)
    .bind(agent, type, slug)
    .first<ArtifactRow>();
}

async function requireKnownType(env: CloudflareBindings, type: string): Promise<void> {
  const row = await env.DB.prepare("SELECT name FROM artifact_types WHERE name = ?").bind(type).first();
  if (!row) throw new McpToolError(`Unknown artifact type '${type}'. Register it first with add_artifact_type.`);
}

function objectKey(id: string, version: number): string {
  return `artifacts/${id}/versions/${String(version)}-${crypto.randomUUID()}`;
}

function decodeBase64(value: string): Uint8Array {
  try {
    const binary = atob(value.replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    throw new McpToolError("content is not valid base64");
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let output = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    output += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(output);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function listArtifacts(env: CloudflareBindings, args: Record<string, unknown>) {
  const clauses = ["status = 'active'"];
  const values: Array<string | number> = [];
  if (args.agent !== undefined) {
    clauses.push("agent = ?");
    values.push(parseAgent(stringArg(args, "agent")));
  }
  if (args.type !== undefined) {
    clauses.push("artifact_type = ?");
    values.push(parseType(stringArg(args, "type")));
  }
  if (args.visibility !== undefined) {
    clauses.push("visibility = ?");
    try { values.push(parseVisibility(args.visibility)); }
    catch { throw new McpToolError("visibility must be private or public"); }
  }
  const limit = args.limit ?? 100;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new McpToolError("limit must be an integer from 1 to 500");
  values.push(limit);
  const result = await env.DB.prepare(`SELECT * FROM artifacts WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`)
    .bind(...values)
    .all<ArtifactRow>();
  return { artifacts: result.results.map((row) => artifactJson(env, row)) };
}

async function getArtifactTool(env: CloudflareBindings, args: Record<string, unknown>) {
  const agent = parseAgent(stringArg(args, "agent"));
  const type = parseType(stringArg(args, "type"));
  const slug = parseSlug(stringArg(args, "name"));
  const row = await getArtifact(env, agent, type, slug);
  if (!row) throw new McpToolError("Artifact not found");
  const versions = await env.DB.prepare("SELECT version, content_type AS contentType, size_bytes AS sizeBytes, sha256, created_at AS createdAt FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC")
    .bind(row.id)
    .all();
  const result: Record<string, unknown> = { artifact: artifactJson(env, row), versions: versions.results };
  if (optionalBoolean(args, "includeContent", false)) {
    if ((row.size_bytes ?? MAX_INLINE_TEXT_BYTES + 1) > MAX_INLINE_TEXT_BYTES) {
      result.contentOmitted = `Artifact is larger than the ${String(MAX_INLINE_TEXT_BYTES)}-byte MCP inline-content limit. Use its canonical URL instead.`;
    } else {
      const object = await env.STORAGE.get(row.current_object_key);
      if (!object) throw new McpToolError("Artifact object is missing from storage");
      const mediaType = row.content_type.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (mediaType === "text/html" || mediaType === "text/markdown") {
        result.content = await object.text();
        result.contentEncoding = "utf8";
      } else {
        result.content = encodeBase64(new Uint8Array(await object.arrayBuffer()));
        result.contentEncoding = "base64";
      }
    }
  }
  return result;
}

async function publishArtifact(env: CloudflareBindings, args: Record<string, unknown>) {
  const agent = parseAgent(stringArg(args, "agent"));
  const type = parseType(stringArg(args, "type"));
  const slug = parseSlug(stringArg(args, "name"));
  let requestedVisibility: Visibility | undefined;
  if (args.visibility !== undefined) {
    try { requestedVisibility = parseVisibility(args.visibility); }
    catch { throw new McpToolError("visibility must be private or public"); }
  }
  const contentType = stringArg(args, "contentType");
  if (!isRenderableContentType(contentType)) throw new McpToolError("Unsupported contentType. Artifacts accepts only HTML and Markdown; publish other files to your CDN.");
  if (typeof args.content !== "string") throw new McpToolError("content must be a string");
  const encoding = args.encoding ?? "utf8";
  if (encoding !== "utf8" && encoding !== "base64") throw new McpToolError("encoding must be utf8 or base64");
  const bytes = encoding === "base64" ? decodeBase64(args.content) : new TextEncoder().encode(args.content);
  if (bytes.byteLength > MAX_PUBLISH_BYTES) throw new McpToolError(`MCP publish payloads are limited to ${String(MAX_PUBLISH_BYTES)} bytes`);
  await requireKnownType(env, type);

  const existing = await getArtifact(env, agent, type, slug, true);
  const visibility = requestedVisibility ?? existing?.visibility ?? "private";
  const id = existing?.id ?? `art_${crypto.randomUUID().replaceAll("-", "")}`;
  const version = (existing?.current_version ?? 0) + 1;
  const key = objectKey(id, version);
  const sha256 = await sha256Hex(bytes);
  const now = new Date().toISOString();

  await env.STORAGE.put(key, bytes, {
    httpMetadata: { contentType },
    customMetadata: { artifactId: id, agent, type, slug, version: String(version), sha256 },
    sha256,
  });

  try {
    if (!existing) {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO artifacts (id, agent, artifact_type, slug, current_version, current_object_key, content_type, size_bytes, sha256, visibility, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)")
          .bind(id, agent, type, slug, version, key, contentType, bytes.byteLength, sha256, visibility, now, now),
        env.DB.prepare("INSERT INTO artifact_versions (artifact_id, version, object_key, content_type, size_bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(id, version, key, contentType, bytes.byteLength, sha256, now),
      ]);
    } else {
      const results = await env.DB.batch([
        env.DB.prepare("UPDATE artifacts SET current_version = ?, current_object_key = ?, content_type = ?, size_bytes = ?, sha256 = ?, status = 'active', deleted_at = NULL, delete_after = NULL, updated_at = ?, visibility = ? WHERE id = ? AND current_version = ?")
          .bind(version, key, contentType, bytes.byteLength, sha256, now, visibility, id, existing.current_version),
        env.DB.prepare("INSERT INTO artifact_versions (artifact_id, version, object_key, content_type, size_bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(id, version, key, contentType, bytes.byteLength, sha256, now),
      ]);
      if ((results[0]?.meta.changes ?? 0) !== 1) throw new McpToolError("Artifact changed during publish; retry the tool call");
    }
  } catch (error) {
    await env.STORAGE.delete(key);
    throw error;
  }

  const row = await getArtifact(env, agent, type, slug);
  if (!row) throw new Error("Published artifact could not be reloaded");
  const warnings = contentType.toLowerCase().includes("text/html") ? remoteImageWarnings(new TextDecoder().decode(bytes)) : [];
  return { artifact: artifactJson(env, row), created: !existing, ...(warnings.length ? { warnings } : {}) };
}

async function deleteArtifact(env: CloudflareBindings, args: Record<string, unknown>) {
  const agent = parseAgent(stringArg(args, "agent"));
  const type = parseType(stringArg(args, "type"));
  const slug = parseSlug(stringArg(args, "name"));
  const row = await getArtifact(env, agent, type, slug);
  if (!row) throw new McpToolError("Artifact not found");
  const deletedAt = new Date();
  const deleteAfter = new Date(deletedAt.getTime() + 86_400_000);
  await env.DB.prepare("UPDATE artifacts SET status = 'deleted', deleted_at = ?, delete_after = ?, updated_at = ? WHERE id = ? AND status = 'active'")
    .bind(deletedAt.toISOString(), deleteAfter.toISOString(), deletedAt.toISOString(), row.id)
    .run();
  return { deleted: true, recoverableUntil: deleteAfter.toISOString(), url: canonicalUrl(env, row) };
}

async function listArtifactTypes(env: CloudflareBindings) {
  const result = await env.DB.prepare("SELECT name, created_at AS createdAt FROM artifact_types ORDER BY name").all();
  return { types: result.results };
}

async function addArtifactType(env: CloudflareBindings, args: Record<string, unknown>) {
  const name = parseType(stringArg(args, "name"));
  const result = await env.DB.prepare("INSERT OR IGNORE INTO artifact_types (name, created_at) VALUES (?, ?)")
    .bind(name, new Date().toISOString())
    .run();
  return { type: name, created: result.meta.changes === 1 };
}

async function runTool(env: CloudflareBindings, name: string, args: Record<string, unknown>) {
  switch (name) {
    case "list_artifacts": return listArtifacts(env, args);
    case "get_artifact": return getArtifactTool(env, args);
    case "publish_artifact": return publishArtifact(env, args);
    case "delete_artifact": return deleteArtifact(env, args);
    case "list_artifact_types": return listArtifactTypes(env);
    case "add_artifact_type": return addArtifactType(env, args);
    default: throw new McpToolError(`Unknown tool '${name}'`);
  }
}

function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function toolResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function handleRpc(env: CloudflareBindings, message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") return rpcError(message.id ?? null, -32600, "Invalid Request");
  const id = message.id ?? null;
  const isNotification = message.id === undefined;

  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return null;
  if (isNotification) return null;

  if (message.method === "initialize") {
    const params = message.params && typeof message.params === "object" ? message.params as Record<string, unknown> : {};
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : LATEST_PROTOCOL_VERSION;
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : LATEST_PROTOCOL_VERSION;
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: "Manage browser-renderable artifacts with MCP as a primary interface. Use publish_artifact with visibility public to share without authentication, or private to restrict access. New artifacts default to private; replacements preserve visibility when omitted. Use get_artifact/list_artifacts to inspect them.",
    });
  }

  if (message.method === "ping") return rpcResult(id, {});
  if (message.method === "tools/list") return rpcResult(id, { tools: TOOLS });
  if (message.method === "tools/call") {
    const params = message.params && typeof message.params === "object" ? message.params as Record<string, unknown> : null;
    if (!params || typeof params.name !== "string") return rpcError(id, -32602, "tools/call requires a tool name");
    try {
      const args = params.arguments === undefined ? {} : asObject(params.arguments);
      return rpcResult(id, toolResult(await runTool(env, params.name, args)));
    } catch (error) {
      if (error instanceof McpToolError) return rpcResult(id, toolResult(error.message, true));
      console.error("Unhandled MCP tool error", error);
      return rpcResult(id, toolResult("Internal server error", true));
    }
  }

  return rpcError(id, -32601, "Method not found");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function handleMcp(request: Request, env: CloudflareBindings): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse(rpcError(null, -32700, "Parse error"), 400);
  }

  if (Array.isArray(payload)) {
    if (payload.length === 0) return jsonResponse(rpcError(null, -32600, "Invalid Request"), 400);
    const responses = (await Promise.all(payload.map((item: unknown) => handleRpc(env, item as JsonRpcRequest)))).filter((item): item is JsonRpcResponse => item !== null);
    return responses.length ? jsonResponse(responses) : new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
  }

  if (!payload || typeof payload !== "object") return jsonResponse(rpcError(null, -32600, "Invalid Request"), 400);
  const response = await handleRpc(env, payload);
  return response ? jsonResponse(response) : new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
}
