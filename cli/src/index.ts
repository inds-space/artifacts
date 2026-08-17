#!/usr/bin/env bun

import { chmod, copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export {};

const VERSION = "0.3.0";
const GITHUB_REPOSITORY = "inds-space/artifacts";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const AGENTS = ["claude", "codex", "antigravity"] as const;

type Config = { baseUrl?: string; accessClientId?: string; accessClientSecret?: string };
type Identity = { agent: string; type: string; name: string };
type Artifact = { agent: string; type: string; name: string; version: number; updatedAt: string; url: string };
type ArtifactEnvelope = { artifact: Artifact; versions?: unknown[] };
type UpdateCheckState = { checkedAt: number; latest?: string };

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
  artifacts update [--force]

Agents: ${AGENTS.join(", ")}

Instance:
  ARTIFACTS_BASE_URL (or "baseUrl" in the config file)

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

function updateCheckPath(): string {
  return join(dirname(configPath()), "update-check.json");
}

function isNewerVersion(candidate: string): boolean {
  const parse = (value: string): [number, number, number] => {
    const [major = 0, minor = 0, patch = 0] = (value.replace(/^v/, "").split(/[+-]/, 1)[0] ?? "").split(".").map(Number);
    return [major, minor, patch];
  };
  const current = parse(VERSION);
  const latest = parse(candidate);
  if (latest[0] !== current[0]) return latest[0] > current[0];
  if (latest[1] !== current[1]) return latest[1] > current[1];
  return latest[2] > current[2];
}

async function latestReleaseTag(): Promise<string | undefined> {
  try {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": `artifacts-cli/${VERSION}` },
    });
    if (!response.ok) return undefined;
    const { tag_name: tag }: { tag_name?: string } = await response.json();
    return tag && /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag) ? tag : undefined;
  } catch {
    return undefined;
  }
}

async function notifyUpdateAvailable(): Promise<void> {
  const path = updateCheckPath();
  let state: UpdateCheckState | undefined;
  try {
    const file = Bun.file(path);
    if (await file.exists()) state = await file.json() as UpdateCheckState;
  } catch {
    state = undefined;
  }

  const now = Date.now();
  if (!state || !Number.isFinite(state.checkedAt) || now - state.checkedAt >= UPDATE_CHECK_INTERVAL_MS) {
    const latest = await latestReleaseTag();
    state = { checkedAt: now, ...(latest ? { latest } : {}) };
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    } catch {
      // An update check must never block the requested command.
    }
  }

  if (state.latest && isNewerVersion(state.latest)) {
    console.error(`Artifacts CLI ${state.latest} is available. Run: artifacts update`);
  }
}

async function loadConfig(): Promise<Required<Config>> {
  let fileConfig: Config = {};
  const file = Bun.file(configPath());
  if (await file.exists()) {
    try { fileConfig = await file.json() as Config; } catch { fail(`Invalid JSON in ${configPath()}`); }
  }
  const baseUrl = (process.env.ARTIFACTS_BASE_URL ?? fileConfig.baseUrl ?? "").replace(/\/$/, "");
  if (!baseUrl) fail(`Set ARTIFACTS_BASE_URL to your Artifacts instance, or add "baseUrl" to ${configPath()}`);
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

async function runProcess(command: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const process = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return { exitCode: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

function releaseAsset(): string {
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : fail(`Unsupported operating system: ${process.platform}`);
  const architecture = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : fail(`Unsupported architecture: ${process.arch}`);
  if (platform === "windows" && architecture !== "x64") fail("Windows updates currently support x64 only");
  return `artifacts-${platform}-${architecture}${platform === "windows" ? ".exe" : ""}`;
}

function updateTarget(): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) fail("LOCALAPPDATA is required to update artifacts on Windows");
    return basename(process.execPath).toLowerCase() === "artifacts.exe"
      ? process.execPath
      : join(localAppData, "Programs", "artifacts", "artifacts.exe");
  }
  return process.execPath;
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function scheduleWindowsUpdate(download: string, target: string, temporaryDirectory: string, version: string): Promise<void> {
  const helper = join(temporaryDirectory, "apply-update.ps1");
  const script = `$ErrorActionPreference = "Stop"
Wait-Process -Id ${String(process.pid)} -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path ${quotePowerShell(dirname(target))} -Force | Out-Null
$deadline = (Get-Date).AddSeconds(30)
$updated = $false
do {
  try {
    Copy-Item -LiteralPath ${quotePowerShell(download)} -Destination ${quotePowerShell(target)} -Force
    $updated = $true
  } catch {
    Start-Sleep -Milliseconds 250
  }
} until ($updated -or (Get-Date) -ge $deadline)
if (-not $updated) { throw "Timed out replacing the artifacts executable" }
Remove-Item -LiteralPath ${quotePowerShell(temporaryDirectory)} -Recurse -Force
`;
  await writeFile(helper, script, "utf8");
  const launcher = `$ErrorActionPreference = "Stop"
$arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ${quotePowerShell(helper)})
Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -WindowStyle Hidden | Out-Null
`;
  const launched = await runProcess([
    "powershell",
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-Command", launcher,
  ]);
  if (launched.exitCode !== 0) fail(launched.stderr || "Could not start the Windows update helper");
  console.log(`Downloaded ${version}. The executable will be replaced after this command exits.`);
}

async function update(args: string[]): Promise<void> {
  const latest = await latestReleaseTag();
  if (!latest) fail(`Could not resolve the latest release of ${GITHUB_REPOSITORY}`);
  if (latest === `v${VERSION}` && !args.includes("--force")) {
    console.log(`Already up to date (${latest}).`);
    return;
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "artifacts-update-"));
  const asset = releaseAsset();
  const download = join(temporaryDirectory, asset);
  const response = await fetch(`https://github.com/${GITHUB_REPOSITORY}/releases/download/${latest}/${asset}`);
  if (!response.ok) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    fail(`Could not download ${asset} (HTTP ${String(response.status)})`);
  }
  await Bun.write(download, response);

  const target = updateTarget();
  if (process.platform === "win32") {
    await scheduleWindowsUpdate(download, target, temporaryDirectory, latest);
    return;
  }

  await mkdir(dirname(target), { recursive: true });
  const replacement = `${target}.new`;
  await copyFile(download, replacement);
  await chmod(replacement, 0o755);
  await rename(replacement, target);
  await rm(temporaryDirectory, { recursive: true, force: true });
  console.log(`Updated artifacts to ${latest}.`);
}

const [command, ...args] = Bun.argv.slice(2);
if (!command || command === "help" || command === "--help" || command === "-h") { help(); await notifyUpdateAvailable(); process.exit(0); }
if (command === "--version" || command === "-v") { console.log(VERSION); await notifyUpdateAvailable(); process.exit(0); }
if (command === "update") { await update(args); process.exit(0); }
await notifyUpdateAvailable();
const config = await loadConfig();
switch (command) {
  case "publish": await publish(args, config); break;
  case "get": await get(args, config); break;
  case "list": await list(args, config); break;
  case "delete": await remove(args, config); break;
  case "type": await types(args, config); break;
  default: fail(`Unknown command '${command}'. Run artifacts --help.`);
}
