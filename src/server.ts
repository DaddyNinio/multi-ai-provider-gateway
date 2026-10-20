/**
 * Hono application: exposes a single Anthropic/OpenAI-compatible surface that
 * fans out to kiro-gateway and copilot-api.
 */
import { Hono } from "hono";
import { authHeader, type Config } from "./config.js";
import { getMergedModels, pickRoute, probe } from "./upstreams.js";

export function createApp(cfg: Config): Hono {
  const app = new Hono();

  app.get("/health", async (c) => {
    const [kiroOk, copilotOk] = await Promise.all([probe(cfg.kiro), probe(cfg.copilot)]);
    const status = kiroOk || copilotOk ? "healthy" : "unhealthy";
    return c.json({
      status,
      upstreams: {
        kiro: { url: cfg.kiro.url, reachable: kiroOk },
        copilot: { url: cfg.copilot.url, reachable: copilotOk },
      },
    });
  });

  app.get("/v1/models", async (c) => {
    const data = await getMergedModels(cfg);
    return c.json({ object: "list", data });
  });

  app.post("/v1/messages", (c) => proxy(c, cfg, "/v1/messages"));
  app.post("/v1/chat/completions", (c) => proxy(c, cfg, "/v1/chat/completions"));

  return app;
}

/**
 * Forward a chat/messages request to the correct upstream based on the "model"
 * field. Supports both streaming (SSE pass-through) and non-streaming.
 */
async function proxy(c: any, cfg: Config, path: string): Promise<Response> {
  const raw = await c.req.text();
  let payload: Record<string, unknown>;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const model = typeof payload.model === "string" ? payload.model : "";
  const route = pickRoute(cfg, model);
  payload.model = route.forwardModel;

  // Forward client headers, overriding host/auth/content-length.
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value: string, key: string) => {
    const k = key.toLowerCase();
    if (k !== "host" && k !== "content-length" && k !== "authorization") {
      headers[key] = value;
    }
  });
  Object.assign(headers, authHeader(route.upstream.key));
  headers["content-type"] = "application/json";

  const url = `${route.upstream.url}${path}`;
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(cfg.requestTimeoutMs),
    });
  } catch (err) {
    return c.json(
      { error: `upstream ${route.upstream.name} unreachable: ${String(err)}` },
      502,
    );
  }

  // Stream SSE bodies straight through; buffer everything else.
  const contentType = upstream.headers.get("content-type") ?? "application/json";
  if (payload.stream && upstream.body) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": contentType },
    });
  }

  const body = await upstream.arrayBuffer();
  return new Response(body, {
    status: upstream.status,
    headers: { "content-type": contentType },
  });
}
