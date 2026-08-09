#!/usr/bin/env bun

export {};

const VERSION = "0.1.2";
const DEFAULT_BASE_URL = "https://artifacts.inds.space";
const AGENTS = ["claude", "codex", "antigravity"] as const;

type Config = { baseUrl?: string; accessClientId?: string; accessClientSecret?: string };
type Identity = { agent: string; type: string; name: string };
type Artifact = { agent: string; type: string; name: string; version: number; updatedAt: string; url: string };
type ArtifactEnvelope = { artifact: Artifact; versions?: unknown[] };

function fail(message: string): never {
  console.error(`artifacts: ${message}`);
  process.exit(1);
}

function help(): void {
  console.log(`Artifacts CLI v${VERSION}

Usage:
  artifacts publish <file> --agent <agent> --type <type> --name <slug>
  artifacts get <agent>/<type>/<name> [--json | --download <file>]
  artifacts list [--agent <agent>] [--type <type>] [--json]
  artifacts delete <agent>/<type>/<name>
  artifacts type list [--json]
  artifacts type add <name>

Agents: ${AGENTS.join(", ")}

Authentication:
  ARTIFACTS_ACCESS_CLIENT_ID and ARTIFACTS_ACCESS_CLIENT_SECRET
  Config: ${configPath()}`);
}

function configPath(): string {
  if (process.platform === "win32") {
    const root = process.env.APPDATA ?? process.env.USERPROFILE;
    if (!root) fail("APPDATA or USERPROFILE is required");
    return `${root}\\artifacts\\config.json`;
  }
  const root = process.env.XDG_CONFIG_HOME ?? (process.env.HOME ? `${process.env.HOME}/.config` : undefined);
  if (!root) fail("HOME or XDG_CONFIG_HOME is required");
  return `${root}/artifacts/config.json`;
}

async function loadConfig(): Promise<Required<Config>> {
  let fileConfig: Config = {};
  const file = Bun.file(configPath());
  if (await file.exists()) {
    try { fileConfig = await file.json() as Config; } catch { fail(`Invalid JSON in ${configPath()}`); }
  }
  const baseUrl = (process.env.ARTIFACTS_BASE_URL ?? fileConfig.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const accessClientId = process.env.ARTIFACTS_ACCESS_CLIENT_ID ?? process.env.PLAN_ACCESS_CLIENT_ID ?? fileConfig.accessClientId ?? "";
  const accessClientSecret = process.env.ARTIFACTS_ACCESS_CLIENT_SECRET ?? process.env.PLAN_ACCESS_CLIENT_SECRET ?? fileConfig.accessClientSecret ?? "";
  if (!accessClientId || !accessClientSecret) fail("Cloudflare Access credentials are required");
  return { baseUrl, accessClientId, accessClientSecret };
}

function authHeaders(config: Required<Config>): Headers {
  return new Headers({
    "CF-Access-Client-Id": config.accessClientId,
    "CF-Access-Client-Secret": config.accessClientSecret,
  });
}

function errorMessage(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") return body.error;
  return fallback;
}

async function api<T>(config: Required<Config>, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  for (const [key, value] of authHeaders(config)) headers.set(key, value);
  headers.set("Accept", "application/json");
  const response = await fetch(`${config.baseUrl}${path}`, { ...init, headers });
  const contentType = response.headers.get("Content-Type") ?? "";
  if (!contentType.includes("application/json")) fail(`Unexpected ${String(response.status)} response from ${config.baseUrl}; verify Cloudflare Access policy and credentials`);
  const body: unknown = await response.json();
  if (!response.ok) fail(errorMessage(body, `HTTP ${String(response.status)}`));
  return body as T;
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function identity(value: string | undefined): Identity {
  const [agent, type, name, extra] = (value ?? "").split("/");
  if (!agent || !type || !name || extra) fail("Identity must be <agent>/<type>/<name>");
  if (!AGENTS.includes(agent as (typeof AGENTS)[number])) fail(`Unknown agent. Supported agents: ${AGENTS.join(", ")}`);
  return { agent, type, name };
}

function contentTypeFor(path: string, detected: string): string {
  const extension = path.toLowerCase().split(".").pop();
  const types: Record<string, string> = {
    html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", txt: "text/plain; charset=utf-8",
    md: "text/markdown; charset=utf-8", css: "text/css; charset=utf-8", js: "application/javascript; charset=utf-8",
    mjs: "application/javascript; charset=utf-8", json: "application/json; charset=utf-8", xml: "application/xml; charset=utf-8",
    svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    avif: "image/avif", pdf: "application/pdf", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
    mp4: "video/mp4", webm: "video/webm", wasm: "application/wasm",
  };
  return types[extension ?? ""] ?? detected;
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

async function publish(args: string[], config: Required<Config>): Promise<void> {
  const path = args[0];
  if (!path || path.startsWith("-")) fail("publish requires a file path");
  const file = Bun.file(path);
  if (!(await file.exists())) fail(`File not found: ${path}`);
  const agent = valueAfter(args, "--agent");
  const type = valueAfter(args, "--type");
  const name = valueAfter(args, "--name");
  if (!agent || !type || !name) fail("publish requires --agent, --type, and --name");
  if (!AGENTS.includes(agent as (typeof AGENTS)[number])) fail(`Unknown agent. Supported agents: ${AGENTS.join(", ")}`);
  const contentType = contentTypeFor(path, file.type);
  const digest = await sha256(path);
  const headers = authHeaders(config);
  headers.set("Content-Type", contentType);
  headers.set("Content-Length", String(file.size));
  headers.set("X-Artifact-SHA256", digest);
  headers.set("Accept", "application/json");
  const query = new URLSearchParams({ agent, type, name });
  const response = await fetch(`${config.baseUrl}/api/v1/artifacts?${query}`, { method: "POST", headers, body: file.stream() });
  const responseType = response.headers.get("Content-Type") ?? "";
  if (!responseType.includes("application/json")) fail(`Unexpected ${String(response.status)} response; verify Cloudflare Access policy and credentials`);
  const raw: unknown = await response.json();
  if (!response.ok) fail(errorMessage(raw, `HTTP ${String(response.status)}`));
  const body = raw as ArtifactEnvelope;
  console.log(body.artifact.url);
}

function printTable(items: Artifact[]): void {
  if (!items.length) { console.log("No artifacts found."); return; }
  const rows = items.map((x) => ({ AGENT:x.agent, TYPE:x.type, NAME:x.name, VERSION:`v${String(x.version)}`, UPDATED:x.updatedAt, URL:x.url }));
  console.table(rows);
}

async function list(args: string[], config: Required<Config>): Promise<void> {
  const query = new URLSearchParams();
  const agent = valueAfter(args, "--agent");
  const type = valueAfter(args, "--type");
  if (agent) query.set("agent", agent);
  if (type) query.set("type", type);
  const body = await api<{ artifacts: Artifact[] }>(config, `/api/v1/artifacts?${query}`);
  if (args.includes("--json")) console.log(JSON.stringify(body.artifacts, null, 2)); else printTable(body.artifacts);
}

async function get(args: string[], config: Required<Config>): Promise<void> {
  const target = identity(args[0]);
  const path = `/api/v1/artifacts/${encodeURIComponent(target.agent)}/${encodeURIComponent(target.type)}/${encodeURIComponent(target.name)}`;
  const body = await api<ArtifactEnvelope>(config, path);
  const output = valueAfter(args, "--download");
  if (output) {
    const response = await fetch(body.artifact.url, { headers: authHeaders(config) });
    if (!response.ok) fail(`Download failed with HTTP ${String(response.status)}`);
    await Bun.write(output, response);
    console.log(output);
  } else if (args.includes("--json")) console.log(JSON.stringify(body, null, 2));
  else console.log(body.artifact.url);
}

async function remove(args: string[], config: Required<Config>): Promise<void> {
  const target = identity(args[0]);
  const path = `/api/v1/artifacts/${encodeURIComponent(target.agent)}/${encodeURIComponent(target.type)}/${encodeURIComponent(target.name)}`;
  const body = await api<{ recoverableUntil: string }>(config, path, { method: "DELETE" });
  console.log(`Deleted. Recoverable until ${body.recoverableUntil}`);
}

async function types(args: string[], config: Required<Config>): Promise<void> {
  const action = args[0];
  if (action === "list") {
    const body = await api<{ types: Array<{ name: string }> }>(config, "/api/v1/types");
    if (args.includes("--json")) console.log(JSON.stringify(body.types, null, 2));
    else for (const item of body.types) console.log(item.name);
    return;
  }
  if (action === "add") {
    const name = args[1];
    if (!name) fail("type add requires a name");
    const body = await api<{ type: string; created: boolean }>(config, `/api/v1/types?name=${encodeURIComponent(name)}`, { method: "POST" });
    console.log(body.created ? `Added ${body.type}` : `${body.type} already exists`);
    return;
  }
  fail("type requires list or add");
}

const [command, ...args] = Bun.argv.slice(2);
if (!command || command === "help" || command === "--help" || command === "-h") { help(); process.exit(0); }
if (command === "--version" || command === "-v") { console.log(VERSION); process.exit(0); }
const config = await loadConfig();
switch (command) {
  case "publish": await publish(args, config); break;
  case "get": await get(args, config); break;
  case "list": await list(args, config); break;
  case "delete": await remove(args, config); break;
  case "type": await types(args, config); break;
  default: fail(`Unknown command '${command}'. Run artifacts --help.`);
}
