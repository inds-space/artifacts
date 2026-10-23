import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function run(args: string[], extraEnv: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "artifacts-cli-test-"));
  directories.push(directory);
  const child = Bun.spawn([process.execPath, "cli/src/index.ts", ...args], {
    env: { ...process.env, XDG_CONFIG_HOME: directory, ARTIFACTS_BASE_URL: "", ARTIFACTS_ACCESS_CLIENT_ID: "", ARTIFACTS_ACCESS_CLIENT_SECRET: "", ...extraEnv }, stdout: "pipe", stderr: "pipe",
  });
  return { directory, code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

test("setup saves a private config and prints an OAuth MCP config without credentials", async () => {
  const result = await run(["setup", "--url", "https://artifacts.example.com", "--save-credentials", "--skip-check"], { ARTIFACTS_ACCESS_CLIENT_ID: "test-client", ARTIFACTS_ACCESS_CLIENT_SECRET: "test-secret" });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('"url": "https://artifacts.example.com/mcp"');
  expect(result.stdout).not.toContain("test-secret");
  const path = join(result.directory, "artifacts/config.json");
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ baseUrl: "https://artifacts.example.com", accessClientSecret: "test-secret" });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test("setup rejects remote HTTP and URLs containing credentials", async () => {
  for (const url of ["http://artifacts.example.com", "https://user:secret@artifacts.example.com", "https://artifacts.example.com/path"]) {
    const result = await run(["setup", "--url", url, "--skip-check"]);
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("Saved configuration");
  }
});

test("doctor and setup verify both CLI health and MCP public publishing", async () => {
  const server = Bun.serve({ port: 0, fetch(request) {
    if (request.headers.get("CF-Access-Client-Secret") !== "test-secret") return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json(new URL(request.url).pathname === "/mcp"
      ? { result: { tools: [{ name: "publish_artifact", inputSchema: { properties: { visibility: { enum: ["private", "public"] } } } }] } }
      : { ok: true });
  } });
  try {
    const env = { ARTIFACTS_BASE_URL: `http://localhost:${String(server.port)}`, ARTIFACTS_ACCESS_CLIENT_ID: "test-client", ARTIFACTS_ACCESS_CLIENT_SECRET: "test-secret" };
    const result = await run(["doctor", "--json"], env);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, publicPublishing: "ok" });
    const setup = await run(["setup"], env);
    expect(setup.code).toBe(0);
    expect(await readFile(join(setup.directory, "artifacts/config.json"), "utf8")).not.toContain("test-secret");
  } finally { await server.stop(true); }
});

test("publish passes public and private visibility and rejects conflicting flags", async () => {
  const observed: { visibility: string | null } = { visibility: null };
  const server = Bun.serve({ port: 0, async fetch(request) {
    observed.visibility = new URL(request.url).searchParams.get("visibility");
    await request.text();
    return Response.json({ artifact: { visibility: observed.visibility, url: "https://artifacts.example.com/public/codex/report/test" } });
  } });
  const directory = await mkdtemp(join(tmpdir(), "artifacts-upload-test-"));
  directories.push(directory);
  const file = join(directory, "report.html");
  await writeFile(file, "<h1>test</h1>");
  const env = { ARTIFACTS_BASE_URL: `http://localhost:${String(server.port)}`, ARTIFACTS_ACCESS_CLIENT_ID: "test-client", ARTIFACTS_ACCESS_CLIENT_SECRET: "test-secret" };
  const args = ["publish", file, "--agent", "codex", "--type", "report", "--name", "test"];
  try {
    for (const [flags, expected] of [[["--public"], "public"], [["--private"], "private"], [["--visibility", "public"], "public"], [[], null]] as const) {
      expect((await run([...args, ...flags], env)).code).toBe(0);
      expect(observed.visibility).toBe(expected);
    }
    expect((await run([...args, "--public", "--private"], env)).code).toBe(1);
    expect((await run([...args, "--visibility", "invalid"], env)).code).toBe(1);
  } finally { await server.stop(true); }
});

test("publish rejects binary files and suffixed names before making any request", async () => {
  let requests = 0;
  const server = Bun.serve({ port: 0, fetch() { requests += 1; return Response.json({}); } });
  const directory = await mkdtemp(join(tmpdir(), "artifacts-format-test-"));
  directories.push(directory);
  const env = { ARTIFACTS_BASE_URL: `http://localhost:${String(server.port)}`, ARTIFACTS_ACCESS_CLIENT_ID: "test-client", ARTIFACTS_ACCESS_CLIENT_SECRET: "test-secret" };
  try {
    for (const extension of ["pdf", "png", "mp3", "mp4", "docx", "json"]) {
      const file = join(directory, `file.${extension}`);
      await writeFile(file, "bytes");
      const result = await run(["publish", file, "--agent", "codex", "--type", "report", "--name", "test"], env);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Only HTML and Markdown");
    }
    const file = join(directory, "report.md");
    await writeFile(file, "# Report");
    for (const name of ["report.html", "report.md"]) {
      const result = await run(["publish", file, "--agent", "codex", "--type", "report", "--name", name], env);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("extensionless");
    }
    expect(requests).toBe(0);
  } finally { await server.stop(true); }
});

test("get --download requests the original Markdown at the extensionless URL", async () => {
  const source = "# Original Markdown\n";
  const observed: { accept: string | null } = { accept: null };
  const server = Bun.serve({ port: 0, fetch(request) {
    if (new URL(request.url).pathname.startsWith("/api/")) {
      return Response.json({ artifact: { url: new URL("/codex/report/readme", request.url).href } });
    }
    observed.accept = request.headers.get("Accept");
    return new Response(observed.accept === "text/markdown" ? source : "<h1>Rendered</h1>");
  } });
  const directory = await mkdtemp(join(tmpdir(), "artifacts-download-test-"));
  directories.push(directory);
  const file = join(directory, "readme.md");
  try {
    const result = await run(["get", "codex/report/readme", "--download", file], {
      ARTIFACTS_BASE_URL: `http://localhost:${String(server.port)}`, ARTIFACTS_ACCESS_CLIENT_ID: "test-client", ARTIFACTS_ACCESS_CLIENT_SECRET: "test-secret",
    });
    expect(result.code).toBe(0);
    expect(observed.accept).toBe("text/markdown");
    expect(await readFile(file, "utf8")).toBe(source);
  } finally { await server.stop(true); }
});
