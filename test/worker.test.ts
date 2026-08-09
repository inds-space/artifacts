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
      url: "https://artifacts.inds.space/codex/plan/auth-refactor",
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

  it("accepts only HTML, PDF, Markdown, images, audio, and video", async () => {
    await resetBindings();
    const accepted = [
      ["html", "text/html; charset=utf-8"],
      ["markdown", "text/markdown; charset=utf-8"],
      ["pdf", "application/pdf"],
      ["image", "image/png"],
      ["audio", "audio/mpeg"],
      ["video", "video/mp4"],
    ] as const;
    for (const [name, contentType] of accepted) {
      const response = await publish("codex", "report", name, "allowed bytes", contentType);
      expect(response.status, `${contentType} should be accepted`).toBe(201);
    }
    for (const [name, contentType] of [["text", "text/plain"], ["css", "text/css"], ["csv", "text/csv"], ["json", "application/json"], ["opaque", "application/octet-stream"]] as const) {
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
