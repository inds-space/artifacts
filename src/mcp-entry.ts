import worker from "./index";
import { handleMcp } from "./mcp";

function hasAccessIdentity(request: Request): boolean {
  return Boolean(
    request.headers.get("Cf-Access-Jwt-Assertion")?.trim() ||
      request.headers.get("Cf-Access-Authenticated-User-Email")?.trim(),
  );
}

function accessRequired(): Response {
  return new Response(JSON.stringify({ error: "Cloudflare Access authentication required" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export default {
  async fetch(request: Request, env: CloudflareBindings, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      if (!hasAccessIdentity(request)) return accessRequired();
      return handleMcp(request, env);
    }
    return worker.fetch(request, env, ctx);
  },
  scheduled(controller: ScheduledController, env: CloudflareBindings, ctx: ExecutionContext): void {
    worker.scheduled(controller, env, ctx);
  },
} satisfies ExportedHandler<CloudflareBindings>;
