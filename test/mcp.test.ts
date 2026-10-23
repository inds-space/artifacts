import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/mcp-entry";

const ACCESS_HEADERS = {
  "Cf-Access-Jwt-Assertion": "test-access-identity",
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
} as const;

let schemaReady = false;

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

async function rpc(method: string, params?: unknown, id = 1): Promise<Response> {
  return dispatch(new Request("http://localhost/mcp", {
    method: "POST",
    headers: ACCESS_HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
  }));
}

describe("artifacts MCP", () => {
  beforeEach(resetBindings);

  it("requires an Access identity", async () => {
    const response = await dispatch(new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    }));
    expect(response.status).toBe(401);
  });

  it("initializes as a stateless Streamable HTTP MCP server", async () => {
    const response = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "inds-space-artifacts", version: "0.5.0" },
      },
    });

    const initialized = await dispatch(new Request("http://localhost/mcp", {
      method: "POST",
      headers: ACCESS_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    }));
    expect(initialized.status).toBe(202);
  });

  it("lists tools with an open custom-agent schema", async () => {
    const response = await rpc("tools/list");
    const body = await response.json<{ result: { tools: Array<{ name: string; inputSchema: { properties?: Record<string, { enum?: string[]; pattern?: string; description?: string }> } }> } }>();
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "list_artifacts",
      "get_artifact",
      "publish_artifact",
      "delete_artifact",
      "list_artifact_types",
      "add_artifact_type",
    ]);
    const publish = body.result.tools.find((tool) => tool.name === "publish_artifact");
    const agent = publish?.inputSchema.properties?.agent;
    expect(agent?.enum).toBeUndefined();
    expect(agent?.pattern).toBeTruthy();
    expect(agent?.description).toContain("chatgpt");
    expect(agent?.description).toContain("Custom agent names are supported");
  });

  it("publishes and reads a ChatGPT artifact through MCP", async () => {
    const published = await rpc("tools/call", {
      name: "publish_artifact",
      arguments: {
        agent: "chatgpt",
        type: "plan",
        name: "mcp-test",
        contentType: "text/markdown; charset=utf-8",
        content: "# MCP works",
      },
    });
    const publishBody = await published.json<{ result: { isError?: boolean; content: Array<{ text: string }> } }>();
    expect(publishBody.result.isError).not.toBe(true);
    expect(publishBody.result.content[0]?.text).toContain('"version": 1');

    const fetched = await rpc("tools/call", {
      name: "get_artifact",
      arguments: { agent: "chatgpt", type: "plan", name: "mcp-test", includeContent: true },
    }, 2);
    const fetchBody = await fetched.json<{ result: { content: Array<{ text: string }> } }>();
    expect(fetchBody.result.content[0]?.text).toContain("# MCP works");
    expect(fetchBody.result.content[0]?.text).toContain(`${env.PUBLIC_BASE_URL}/chatgpt/plan/mcp-test`);
  });

  it("rejects non-document formats and filename extensions through MCP", async () => {
    for (const contentType of ["application/pdf", "image/png", "audio/mpeg", "video/mp4", "application/octet-stream"]) {
      const response = await rpc("tools/call", { name: "publish_artifact", arguments: {
        agent: "codex", type: "report", name: "rejected", contentType, content: "bytes",
      } });
      const body = await response.json<{ result: { isError: boolean; content: Array<{ text: string }> } }>();
      expect(body.result.isError, contentType).toBe(true);
      expect(body.result.content[0]?.text).toContain("only HTML and Markdown");
    }
    for (const name of ["report.md", "report.html"]) {
      const response = await rpc("tools/call", { name: "publish_artifact", arguments: {
        agent: "codex", type: "report", name, contentType: "text/markdown", content: "# Report",
      } });
      const body = await response.json<{ result: { isError: boolean } }>();
      expect(body.result.isError).toBe(true);
    }
    expect((await env.STORAGE.list()).objects).toHaveLength(0);
  });

  it("accepts arbitrary valid custom agent slugs", async () => {
    const published = await rpc("tools/call", {
      name: "publish_artifact",
      arguments: {
        agent: "my-local-agent",
        type: "report",
        name: "custom-agent-test",
        contentType: "text/markdown; charset=utf-8",
        content: "# custom",
      },
    });
    const body = await published.json<{ result: { isError?: boolean; content: Array<{ text: string }> } }>();
    expect(body.result.isError).not.toBe(true);
    expect(body.result.content[0]?.text).toContain('"agent": "my-local-agent"');
  });

  it("keeps the existing non-MCP worker routes available", async () => {
    const response = await dispatch(new Request("http://localhost/api/v1/health", {
      headers: { "Cf-Access-Jwt-Assertion": "test-access-identity" },
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "artifacts" });
  });
});

describe("MCP public publishing", () => {
  beforeEach(resetBindings);

  async function call(name: string, args: Record<string, unknown>) {
    const response = await rpc("tools/call", { name, arguments: args });
    return response.json<{ result: { isError?: boolean; content: Array<{ text: string }> } }>();
  }

  it("advertises visibility on publish and list", async () => {
    const response = await rpc("tools/list");
    const body = await response.json<{ result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> } }>();
    for (const name of ["publish_artifact", "list_artifacts"]) {
      expect(body.result.tools.find((tool) => tool.name === name)?.inputSchema.properties.visibility).toMatchObject({ enum: ["private", "public"] });
    }
  });

  it("publishes, replaces, filters, reads, and revokes public artifacts using MCP", async () => {
    const identity = { agent: "codex", type: "report", name: "mcp-public" };
    const upload = { ...identity, contentType: "text/html", content: "<h1>MCP public</h1>" };
    const created = await call("publish_artifact", { ...upload, visibility: "public" });
    expect(created.result.isError).not.toBe(true);
    const publicUrl = `${env.PUBLIC_BASE_URL}/public/codex/report/mcp-public`;
    expect(JSON.parse(created.result.content[0]?.text ?? "")).toMatchObject({ artifact: { visibility: "public", url: publicUrl } });
    expect(await (await dispatch(new Request(publicUrl))).text()).toBe(upload.content);
    const replaced = await call("publish_artifact", upload);
    expect(JSON.parse(replaced.result.content[0]?.text ?? "")).toMatchObject({ artifact: { visibility: "public", version: 2 } });
    const fetched = await call("get_artifact", { ...identity, includeContent: true });
    expect(JSON.parse(fetched.result.content[0]?.text ?? "")).toMatchObject({ artifact: { visibility: "public", url: publicUrl }, content: upload.content });
    const listed = await call("list_artifacts", { visibility: "public" });
    expect(JSON.parse(listed.result.content[0]?.text ?? "")).toMatchObject({ artifacts: [{ visibility: "public" }] });
    const invalid = await call("publish_artifact", { ...upload, visibility: true });
    expect(invalid.result.isError).toBe(true);
    expect((await call("list_artifacts", { visibility: "invalid" })).result.isError).toBe(true);
    await call("publish_artifact", { ...upload, visibility: "private" });
    expect((await dispatch(new Request(publicUrl))).status).toBe(404);
    const privateList = await call("list_artifacts", { visibility: "public" });
    expect(JSON.parse(privateList.result.content[0]?.text ?? "")).toEqual({ artifacts: [] });
    await call("publish_artifact", { ...upload, visibility: "public" });
    await call("delete_artifact", identity);
    expect((await dispatch(new Request(publicUrl))).status).toBe(404);
  });
});
