/**
 * Hono application: exposes a single Anthropic/OpenAI-compatible surface that
 * fans out to kiro-gateway and copilot-api, plus a local monitoring dashboard.
 */
import { Hono } from "hono";
import { authHeader, type Config, type UpstreamConfig } from "./config.js";
import { getMergedModels, pickRoute, probe } from "./upstreams.js";
import { DASHBOARD_HTML } from "./dashboard.js";
import { extractUsage, record, snapshot } from "./stats.js";

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

  // Live token-usage stats accumulated by this gateway.
  app.get("/stats", (c) => c.json(snapshot()));

  // Best-effort credit/quota info pulled from upstreams.
  app.get("/credits", async (c) => c.json({ upstreams: await getCredits(cfg) }));

  // Human-friendly monitoring page.
  app.get("/dashboard", (c) => c.html(DASHBOARD_HTML));
  app.get("/", (c) => c.redirect("/dashboard"));

  app.post("/v1/messages", (c) => proxy(c, cfg, "/v1/messages"));
  app.post("/v1/chat/completions", (c) => proxy(c, cfg, "/v1/chat/completions"));

  return app;
}

/** Query each upstream for any credit/quota endpoint it exposes. */
async function getCredits(cfg: Config): Promise<Record<string, unknown>> {
  async function fetchUsage(up: UpstreamConfig, path: string) {
    try {
      const res = await fetch(`${up.url}${path}`, {
        headers: authHeader(up.key),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return { available: false };
      return { available: true, data: await res.json() };
    } catch {
      return { available: false };
    }
  }
  const [copilot, kiro] = await Promise.all([
    fetchUsage(cfg.copilot, "/usage"), // copilot-api exposes Copilot quota here
    fetchUsage(cfg.kiro, "/usage"), // kiro-gateway may not; handled gracefully
  ]);
  return { "copilot-api": copilot, "kiro-gateway": kiro };
}

/**
 * Forward a chat/messages request to the correct upstream based on the "model"
 * field. Records token usage for the dashboard. Supports streaming + buffered.
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
    record({ backend: route.upstream.name, model, ok: false });
    return c.json(
      { error: `upstream ${route.upstream.name} unreachable: ${String(err)}` },
      502,
    );
  }

  const contentType = upstream.headers.get("content-type") ?? "application/json";
  const ok = upstream.ok;

  // Streaming: tee the body so we can parse token usage from SSE without
  // blocking the client stream.
  if (payload.stream && upstream.body) {
    const [clientStream, tapStream] = upstream.body.tee();
    void tapStreamUsage(tapStream, route.upstream.name, model, ok);
    return new Response(clientStream, {
      status: upstream.status,
      headers: { "content-type": contentType },
    });
  }

  const buf = await upstream.arrayBuffer();
  // Parse usage from the buffered JSON body.
  try {
    const parsed = JSON.parse(new TextDecoder().decode(buf));
    const u = extractUsage(parsed);
    record({ backend: route.upstream.name, model, ok, inputTokens: u.inputTokens, outputTokens: u.outputTokens });
  } catch {
    record({ backend: route.upstream.name, model, ok });
  }
  return new Response(buf, {
    status: upstream.status,
    headers: { "content-type": contentType },
  });
}

/** Read an SSE stream copy, extract usage from the final events, record once. */
async function tapStreamUsage(
  stream: ReadableStream<Uint8Array>,
  backend: string,
  model: string,
  ok: boolean,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let input = 0;
  let output = 0;
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Scan complete SSE data lines for usage fields.
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const obj = JSON.parse(data);
          const u = extractUsage(obj);
          if (u.inputTokens) input = u.inputTokens;
          if (u.outputTokens) output = Math.max(output, u.outputTokens);
          // Anthropic streams output tokens in message_delta.usage
          const deltaUsage = obj?.usage ?? obj?.message?.usage;
          if (deltaUsage?.output_tokens) output = Math.max(output, deltaUsage.output_tokens);
          if (deltaUsage?.input_tokens) input = Math.max(input, deltaUsage.input_tokens);
        } catch {
          // ignore non-JSON data lines
        }
      }
    }
  } catch {
    // stream ended abruptly; record what we have
  } finally {
    record({ backend, model, ok, inputTokens: input, outputTokens: output });
  }
}
