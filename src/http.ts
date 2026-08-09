const SECURITY_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

export function secureHeaders(headers = new Headers()): Headers {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return headers;
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = secureHeaders(new Headers(init.headers));
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "private, no-store");
  return Response.json(body, { ...init, headers });
}

export function methodNotAllowed(methods: readonly string[]): Response {
  return json({ error: "Method not allowed" }, { status: 405, headers: { Allow: methods.join(", ") } });
}

export function landing(body: string): Response {
  const headers = secureHeaders();
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "private, no-store");
  headers.set("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'");
  return new Response(body, { headers });
}
