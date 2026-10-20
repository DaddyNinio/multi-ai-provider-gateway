/**
 * Hono application: a single Anthropic/OpenAI-compatible surface backed by two
 * in-process providers (Kiro runtime + GitHub Copilot), plus a local monitor.
 */
import { Hono } from "hono";
import type { Config } from "./config.js";
import { getMergedModels, health, pickRoute } from "./upstreams.js";
import { DASHBOARD_HTML } from "./dashboard.js";
import { extractUsage, record, snapshot } from "./stats.js";
import * as copilot from "./providers/copilot.js";
import * as kiro from "./providers/kiro.js";

export function createApp(cfg: Config): Hono {
  const app = new Hono();

  app.get("/health", async (c) => {
    const h = await health(cfg);
    return c.json({
      status: h.kiro || h.copilot ? "healthy" : "unhealthy",
      providers: {
        "kiro-gateway": { reachable: h.kiro },
        "copilot-api": { reachable: h.copilot },
      },
    });
  });

  app.get("/v1/models", async (c) => {
    const data = await getMergedModels(cfg);
    return c.json({ object: "list", data });
  });

  app.get("/stats", (c) => c.json(snapshot()));
  app.get("/credits", async (c) => c.json({ providers: await getCredits() }));
  app.get("/dashboard", (c) => c.html(DASHBOARD_HTML));
  app.get("/", (c) => c.redirect("/dashboard"));

  // Anthropic Messages API.
  app.post("/v1/messages", (c) => handleMessages(c, cfg));
  // OpenAI Chat Completions API.
  app.post("/v1/chat/completions", (c) => handleChatCompletions(c, cfg));

  return app;
}

/** Best-effort credit/quota info. Copilot exposes quota via its token endpoint. */
async function getCredits(): Promise<Record<string, unknown>> {
  const providers: Record<string, unknown> = {};
  try {
    await copilot.getCopilotToken();
    providers["copilot-api"] = { available: true, note: "authenticated" };
  } catch {
    providers["copilot-api"] = { available: false };
  }
  try {
    kiro.getKiroCredentials();
    providers["kiro-gateway"] = { available: true, note: "authenticated" };
  } catch {
    providers["kiro-gateway"] = { available: false };
  }
  return providers;
}

/** Anthropic /v1/messages: route to kiro (native) or copilot (translate). */
async function handleMessages(c: any, cfg: Config): Promise<Response> {
  const payload = await readJson(c);
  if (!payload) return c.json({ error: "invalid JSON body" }, 400);

  const model = typeof payload.model === "string" ? payload.model : "";
  const route = pickRoute(cfg, model);
  const signal = AbortSignal.timeout(cfg.requestTimeoutMs);

  try {
    if (route.backend === "kiro-gateway") {
      const res = await kiro.chat({ ...payload, model: route.model } as kiro.AnthropicMessagesRequest, { signal });
      return finishAnthropic(res, route.backend, model);
    }
    // Copilot speaks OpenAI; translate Anthropic -> OpenAI -> Anthropic.
    const oai = anthropicToOpenAI({ ...payload, model: route.model });
    const result = await copilot.chatCompletions(oai, { signal });
    if (payload.stream && result instanceof Response) {
      // Pass the OpenAI SSE through; clients pointed at copilot models via
      // /v1/messages are rare, so we stream raw OpenAI events.
      record({ backend: route.backend, model, ok: result.ok });
      return new Response(result.body, {
        status: result.status,
        headers: { "content-type": "text/event-stream" },
      });
    }
    const anthropic = openAIToAnthropic(result, model);
    const u = extractUsage(result);
    record({ backend: route.backend, model, ok: true, inputTokens: u.inputTokens, outputTokens: u.outputTokens });
    return c.json(anthropic);
  } catch (err) {
    record({ backend: route.backend, model, ok: false });
    return c.json({ type: "error", error: { message: String((err as Error).message) } }, 502);
  }
}

/** OpenAI /v1/chat/completions: route to copilot (native) or kiro (translate). */
async function handleChatCompletions(c: any, cfg: Config): Promise<Response> {
  const payload = await readJson(c);
  if (!payload) return c.json({ error: "invalid JSON body" }, 400);

  const model = typeof payload.model === "string" ? payload.model : "";
  const route = pickRoute(cfg, model);
  const signal = AbortSignal.timeout(cfg.requestTimeoutMs);

  try {
    if (route.backend === "copilot-api") {
      const result = await copilot.chatCompletions({ ...payload, model: route.model } as copilot.ChatCompletionPayload, { signal });
      if (payload.stream && result instanceof Response) {
        record({ backend: route.backend, model, ok: result.ok });
        return new Response(result.body, {
          status: result.status,
          headers: { "content-type": "text/event-stream" },
        });
      }
      const u = extractUsage(result);
      record({ backend: route.backend, model, ok: true, inputTokens: u.inputTokens, outputTokens: u.outputTokens });
      return c.json(result);
    }
    // Kiro speaks Anthropic; translate OpenAI -> Anthropic -> OpenAI.
    const anthropicReq = openAIReqToAnthropic({ ...payload, model: route.model });
    const res = await kiro.chat(anthropicReq, { signal });
    const text = anthropicResText(res);
    record({ backend: route.backend, model, ok: true });
    return c.json(openAIChatResponse(text, model));
  } catch (err) {
    record({ backend: route.backend, model, ok: false });
    return c.json({ error: { message: String((err as Error).message) } }, 502);
  }
}

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //

async function readJson(c: any): Promise<Record<string, any> | null> {
  const raw = await c.req.text();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
}

/** Return an Anthropic result from a provider, recording usage. */
function finishAnthropic(res: unknown, backend: string, model: string): Response {
  if (res instanceof Response) {
    record({ backend, model, ok: res.ok });
    return new Response(res.body, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "text/event-stream" },
    });
  }
  const u = extractUsage(res);
  record({ backend, model, ok: true, inputTokens: u.inputTokens, outputTokens: u.outputTokens });
  return new Response(JSON.stringify(res), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Flatten Anthropic message content blocks to a plain string. */
function anthropicContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text ?? "")
      .join("");
  }
  return "";
}

/** Anthropic Messages request -> OpenAI chat payload. */
function anthropicToOpenAI(p: any): any {
  const messages: any[] = [];
  if (p.system) messages.push({ role: "system", content: p.system });
  for (const m of p.messages ?? []) {
    messages.push({ role: m.role, content: anthropicContentToText(m.content) });
  }
  return {
    model: p.model,
    messages,
    max_tokens: p.max_tokens,
    temperature: p.temperature,
    stream: Boolean(p.stream),
  };
}

/** OpenAI chat response -> Anthropic Messages response. */
function openAIToAnthropic(result: any, model: string): any {
  const text = result?.choices?.[0]?.message?.content ?? "";
  return {
    id: `msg_${(result?.id ?? "x").toString().slice(0, 24)}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: {
      input_tokens: result?.usage?.prompt_tokens ?? 0,
      output_tokens: result?.usage?.completion_tokens ?? 0,
    },
  };
}

/** OpenAI chat request -> Anthropic Messages request (for kiro). */
function openAIReqToAnthropic(p: any): any {
  const system = (p.messages ?? []).filter((m: any) => m.role === "system").map((m: any) => m.content).join("\n");
  const messages = (p.messages ?? [])
    .filter((m: any) => m.role !== "system")
    .map((m: any) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content ?? "") }));
  return { model: p.model, messages, max_tokens: p.max_tokens ?? 1024, system: system || undefined, stream: false };
}

/** Pull text out of an Anthropic-shaped provider result. */
function anthropicResText(res: any): string {
  if (res && typeof res === "object" && Array.isArray(res.content)) {
    return anthropicContentToText(res.content);
  }
  return "";
}

/** Build an OpenAI chat completion response wrapping a plain text. */
function openAIChatResponse(text: string, model: string): any {
  return {
    id: `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
