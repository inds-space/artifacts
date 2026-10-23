import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const ACCESS_HEADERS = { "Cf-Access-Jwt-Assertion": "test-access-identity" } as const;
let schemaReady = false;

async function digest(source: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function resetBindings(): Promise<void> {
  if (!schemaReady) {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    schemaReady = true;
  }
  await env.DB.exec("DELETE FROM artifact_versions; DELETE FROM artifacts; DELETE FROM artifact_types;");
  const now = new Date().toISOString();
  for (const type of ["plan", "presentation", "report"]) {
    await env.DB.prepare("INSERT INTO artifact_types (name, created_at) VALUES (?, ?)").bind(type, now).run();
  }
  const listed = await env.STORAGE.list();
  if (listed.objects.length) await env.STORAGE.delete(listed.objects.map((object) => object.key));
}

async function dispatch(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function publish(agent: string, type: string, name: string, body: string, contentType = "text/html; charset=utf-8"): Promise<Response> {
  return dispatch(new Request(`http://localhost/api/v1/artifacts?agent=${agent}&type=${type}&name=${name}`, {
    method: "POST",
    headers: {
      ...ACCESS_HEADERS,
      "Content-Type": contentType,
      "Content-Length": String(new TextEncoder().encode(body).byteLength),
      "X-Artifact-SHA256": await digest(body),
    },
    body,
  }));
}

describe("artifacts Worker", () => {
  it("rejects requests that did not pass through Access", async () => {
    const response = await dispatch(new Request("http://localhost/api/v1/health"));
    expect(response.status).toBe(401);
  });

  it("creates, serves, and replaces a stable typed artifact URL", async () => {
    await resetBindings();
    const first = "<!doctype html><title>One</title><h1>Version one</h1>";
    const created = await publish("codex", "plan", "auth-refactor", first);
    expect(created.status, await created.clone().text()).toBe(201);
    await expect(created.json()).resolves.toMatchObject({ artifact: {
      agent: "codex", type: "plan", name: "auth-refactor", version: 1,
      url: `${env.PUBLIC_BASE_URL}/codex/plan/auth-refactor`,
    }});

    const second = "<!doctype html><title>Two</title><h1>Version two</h1>";
    const replaced = await publish("codex", "plan", "auth-refactor", second);
    expect(replaced.status).toBe(200);
    await expect(replaced.json()).resolves.toMatchObject({ artifact: { version: 2 } });

    const viewed = await dispatch(new Request("http://localhost/codex/plan/auth-refactor", { headers: ACCESS_HEADERS }));
    expect(viewed.status).toBe(200);
    expect(viewed.headers.get("Cache-Control")).toBe("no-store, no-transform");
    expect(viewed.headers.get("X-Artifact-Version")).toBe("2");
    expect(viewed.headers.get("ETag")).toBe(`"${await digest(second)}"`);
    await expect(viewed.text()).resolves.toBe(second);

    const versions = await env.DB.prepare("SELECT version FROM artifact_versions ORDER BY version").all<{ version: number }>();
    expect(versions.results.map((row) => row.version)).toEqual([1, 2]);
  });

  it("lists and filters artifacts, and get returns metadata and versions", async () => {
    await resetBindings();
    await publish("codex", "plan", "one", "<h1>One</h1>");
    await publish("claude", "report", "two", "<h1>Two</h1>");
    const filtered = await dispatch(new Request("http://localhost/api/v1/artifacts?agent=codex&type=plan", { headers: ACCESS_HEADERS }));
    const listed = await filtered.json<{ artifacts: Array<{ agent: string; type: string; name: string }> }>();
    expect(listed.artifacts).toEqual([expect.objectContaining({ agent: "codex", type: "plan", name: "one" })]);

    const metadata = await dispatch(new Request("http://localhost/api/v1/artifacts/codex/plan/one", { headers: ACCESS_HEADERS }));
    await expect(metadata.json()).resolves.toMatchObject({ artifact: { name: "one", version: 1 }, versions: [{ version: 1 }] });
  });

  it("lists and adds artifact types idempotently", async () => {
    await resetBindings();
    const added = await dispatch(new Request("http://localhost/api/v1/types?name=research-brief", { method: "POST", headers: ACCESS_HEADERS }));
    expect(added.status).toBe(201);
    await expect(added.json()).resolves.toEqual({ type: "research-brief", created: true });
    const repeated = await dispatch(new Request("http://localhost/api/v1/types?name=research-brief", { method: "POST", headers: ACCESS_HEADERS }));
    expect(repeated.status).toBe(200);
    const listed = await dispatch(new Request("http://localhost/api/v1/types", { headers: ACCESS_HEADERS }));
    const body = await listed.json<{ types: Array<{ name: string }> }>();
    expect(body.types.map((item) => item.name)).toContain("research-brief");
  });

  it("accepts only HTML and Markdown", async () => {
    await resetBindings();
    const accepted = [
      ["html", "text/html; charset=utf-8"],
      ["markdown", "text/markdown; charset=utf-8"],
    ] as const;
    for (const [name, contentType] of accepted) {
      const response = await publish("codex", "report", name, "allowed bytes", contentType);
      expect(response.status, `${contentType} should be accepted`).toBe(201);
    }
    for (const [name, contentType] of [["pdf", "application/pdf"], ["image", "image/png"], ["audio", "audio/mpeg"], ["video", "video/mp4"], ["word", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"], ["svg", "image/svg+xml"], ["text", "text/plain"], ["css", "text/css"], ["csv", "text/csv"], ["json", "application/json"], ["opaque", "application/octet-stream"]] as const) {
      const response = await publish("codex", "report", name, "rejected bytes", contentType);
      expect(response.status, `${contentType} should be rejected`).toBe(415);
    }
    const unknownType = await publish("codex", "unknown", "sample", "<h1>x</h1>");
    expect(unknownType.status).toBe(400);
    const badHash = await dispatch(new Request("http://localhost/api/v1/artifacts?agent=codex&type=plan&name=bad-hash", {
      method: "POST", headers: { ...ACCESS_HEADERS, "Content-Type": "text/html", "X-Artifact-SHA256": "bad" }, body: "<h1>x</h1>",
    }));
    expect(badHash.status).toBe(400);
  });

  it("serves Markdown as HTML at extensionless private and public URLs while retaining the source", async () => {
    await resetBindings();
    const source = "# A report\n\n| A | B |\n| - | - |\n| one | two |\n\n- [x] Done\n\n<script>alert(1)</script>";
    const created = await publish("codex", "report", "markdown-demo", source, "Text/Markdown; charset=utf-8");
    expect(created.status).toBe(201);
    const result = await created.json<{ artifact: { url: string; contentType: string } }>();
    expect(result.artifact.url).toBe(`${env.PUBLIC_BASE_URL}/codex/report/markdown-demo`);
    expect(result.artifact.contentType).toBe("Text/Markdown; charset=utf-8");
    const path = "http://localhost/codex/report/markdown-demo";
    const viewed = await dispatch(new Request(path, { headers: ACCESS_HEADERS }));
    expect(viewed.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(viewed.headers.get("Content-Security-Policy")).not.toContain("script-src 'unsafe-inline'");
    const html = await viewed.text();
    expect(html).toContain('<h1 id="user-content-a-report">A report</h1>');
    expect(html).toContain("<table>");
    expect(html).not.toContain("<script>");
    const raw = await dispatch(new Request(path, { headers: { ...ACCESS_HEADERS, Accept: "text/markdown" } }));
    expect(raw.headers.get("Content-Type")).toBe("Text/Markdown; charset=utf-8");
    expect(raw.headers.get("Vary")).toBe("Accept");
    expect(raw.headers.get("ETag")).not.toBe(viewed.headers.get("ETag"));
    expect(await raw.text()).toBe(source);
    const head = await dispatch(new Request(path, { method: "HEAD", headers: ACCESS_HEADERS }));
    expect(head.headers.get("ETag")).toBe(viewed.headers.get("ETag"));
    expect(head.headers.get("Content-Type")).toBe(viewed.headers.get("Content-Type"));
    expect(await head.text()).toBe("");
    expect((await dispatch(new Request(path, { headers: { ...ACCESS_HEADERS, "If-None-Match": viewed.headers.get("ETag") ?? "" } }))).status).toBe(304);
    const row = await env.DB.prepare("SELECT current_object_key FROM artifacts WHERE slug = 'markdown-demo'").first<{ current_object_key: string }>();
    if (!row) throw new Error("Published row missing");
    const stored = await env.STORAGE.get(row.current_object_key);
    if (!stored) throw new Error("Published source missing");
    expect(await stored.text()).toBe(source);
    await env.DB.prepare("UPDATE artifacts SET visibility = 'public' WHERE slug = 'markdown-demo'").run();
    const publicView = await dispatch(new Request("http://localhost/public/codex/report/markdown-demo"));
    expect(await publicView.text()).toBe(html);
    for (const extension of ["md", "html"]) {
      expect((await publish("codex", "report", `has-extension.${extension}`, source)).status).toBe(400);
      expect((await dispatch(new Request(`${path}.${extension}`, { headers: ACCESS_HEADERS }))).status).toBe(400);
    }
  });

  it("soft-deletes for 24 hours and removes the canonical route", async () => {
    await resetBindings();
    await publish("antigravity", "presentation", "temporary", "<h1>Temporary</h1>");
    const deleted = await dispatch(new Request("http://localhost/api/v1/artifacts/antigravity/presentation/temporary", { method: "DELETE", headers: ACCESS_HEADERS }));
    expect(deleted.status).toBe(200);
    const body = await deleted.json<{ deleted: boolean; recoverableUntil: string }>();
    expect(body.deleted).toBe(true);
    expect(Date.parse(body.recoverableUntil)).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    const viewed = await dispatch(new Request("http://localhost/antigravity/presentation/temporary", { headers: ACCESS_HEADERS }));
    expect(viewed.status).toBe(404);
    const row = await env.DB.prepare("SELECT status, delete_after FROM artifacts").first<{ status: string; delete_after: string }>();
    expect(row?.status).toBe("deleted");
    expect(row?.delete_after).toBeTruthy();
  });
});

describe("public artifacts", () => {
  async function publishVisible(visibility?: string, body = "<h1>Public test</h1>") {
    const query = new URLSearchParams({ agent: "custom-agent", type: "report", name: "visibility-test" });
    if (visibility !== undefined) query.set("visibility", visibility);
    return dispatch(new Request(`http://localhost/api/v1/artifacts?${query}`, {
      method: "POST", headers: { ...ACCESS_HEADERS, "Content-Type": "text/html", "X-Artifact-SHA256": await digest(body) }, body,
    }));
  }
  const publicUrl = "http://localhost/public/custom-agent/report/visibility-test";

  it("defaults to private, requires explicit public opt-in, and never exposes private content or ETags", async () => {
    await resetBindings();
    const created = await publishVisible();
    await expect(created.json()).resolves.toMatchObject({ artifact: { visibility: "private" } });
    const response = await dispatch(new Request(publicUrl, { headers: { "If-None-Match": `"${await digest("<h1>Public test</h1>")}"` } }));
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("<h1>");
    expect((await dispatch(new Request("http://localhost/custom-agent/report/visibility-test"))).status).toBe(401);
    expect((await publishVisible("invalid")).status).toBe(400);
  });

  it("serves GET, HEAD, and conditional reads without Access and revokes immediately", async () => {
    await resetBindings();
    const created = await publishVisible("public");
    await expect(created.json()).resolves.toMatchObject({ artifact: { visibility: "public", url: `${env.PUBLIC_BASE_URL}/public/custom-agent/report/visibility-test` } });
    const viewed = await dispatch(new Request(publicUrl));
    expect(viewed.status).toBe(200);
    expect(viewed.headers.get("Cache-Control")).toBe("no-store, no-transform");
    expect(viewed.headers.get("Content-Security-Policy")).toContain("connect-src 'none'");
    await expect(viewed.text()).resolves.toBe("<h1>Public test</h1>");
    const head = await dispatch(new Request(publicUrl, { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const etag = head.headers.get("ETag") ?? "";
    expect((await dispatch(new Request(publicUrl, { headers: { "If-None-Match": etag } }))).status).toBe(304);
    expect((await dispatch(new Request(publicUrl, { method: "POST", body: "tamper" }))).status).toBe(405);
    await publishVisible(undefined, "<h1>Replacement</h1>");
    await expect((await dispatch(new Request(publicUrl))).text()).resolves.toBe("<h1>Replacement</h1>");
    const filtered = await dispatch(new Request("http://localhost/api/v1/artifacts?visibility=public", { headers: ACCESS_HEADERS }));
    await expect(filtered.json()).resolves.toMatchObject({ artifacts: [{ visibility: "public" }] });
    await publishVisible("private");
    expect((await dispatch(new Request(publicUrl, { headers: { "If-None-Match": etag } }))).status).toBe(404);
    expect((await dispatch(new Request(publicUrl, { headers: ACCESS_HEADERS }))).status).toBe(404);
  });

  it("removes deleted public artifacts and keeps management, history, and malformed routes protected", async () => {
    await resetBindings();
    await publishVisible("public");
    const deleted = await dispatch(new Request("http://localhost/api/v1/artifacts/custom-agent/report/visibility-test", { method: "DELETE", headers: ACCESS_HEADERS }));
    await expect(deleted.json()).resolves.toMatchObject({ deleted: true, url: `${env.PUBLIC_BASE_URL}/public/custom-agent/report/visibility-test` });
    expect((await dispatch(new Request(publicUrl))).status).toBe(404);
    await publishVisible();
    expect((await dispatch(new Request(publicUrl))).status).toBe(200); // restore preserves explicit visibility
    for (const path of ["/api/v1/artifacts", "/api/v1/types", "/api/v1/artifacts/custom-agent/report/visibility-test"]) {
      expect((await dispatch(new Request(`http://localhost${path}`))).status).toBe(401);
    }
    for (const path of ["/public/api/v1/artifacts", "/public/mcp", "/public/custom-agent/report/visibility-test/versions/1", "/public/custom-agent%2Freport/report/visibility-test"]) {
      expect((await dispatch(new Request(`http://localhost${path}`))).status).not.toBe(200);
    }
  });
});
