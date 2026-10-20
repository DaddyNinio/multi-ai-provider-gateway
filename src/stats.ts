/**
 * In-memory usage tracking: request counts and token totals per model/backend.
 * Resets when the process restarts (no persistence by design — it's a live monitor).
 */

import { estimateCost } from "./pricing.js";

export interface ModelStat {
  model: string;
  backend: string;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  lastUsed: string | null;
  /** Estimated USD spend for this model, or null if price unknown (e.g. Kiro). */
  estCostUsd: number | null;
}

interface Totals {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated USD spend across models with known pricing. */
  estCostUsd: number;
}

const stats = new Map<string, ModelStat>();
const startedAt = new Date().toISOString();

function keyOf(backend: string, model: string): string {
  return `${backend}::${model}`;
}

function ensure(backend: string, model: string): ModelStat {
  const key = keyOf(backend, model);
  let s = stats.get(key);
  if (!s) {
    s = {
      model,
      backend,
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      lastUsed: null,
      estCostUsd: null,
    };
    stats.set(key, s);
  }
  return s;
}

/**
 * Record one request's outcome. Token counts are best-effort: extracted from
 * the upstream response body when present (Anthropic `usage.input_tokens` /
 * `output_tokens`, or OpenAI `usage.prompt_tokens` / `completion_tokens`).
 */
export function record(params: {
  backend: string;
  model: string;
  ok: boolean;
  inputTokens?: number;
  outputTokens?: number;
}): void {
  const s = ensure(params.backend, params.model);
  s.requests += 1;
  if (!params.ok) s.errors += 1;
  if (params.inputTokens) s.inputTokens += params.inputTokens;
  if (params.outputTokens) s.outputTokens += params.outputTokens;
  s.lastUsed = new Date().toISOString();
}

/** Try to pull token usage out of a parsed response body (either API shape). */
export function extractUsage(body: unknown): { inputTokens: number; outputTokens: number } {
  const out = { inputTokens: 0, outputTokens: 0 };
  if (!body || typeof body !== "object") return out;
  const usage = (body as Record<string, any>).usage;
  if (!usage || typeof usage !== "object") return out;
  // Anthropic shape
  if (typeof usage.input_tokens === "number") out.inputTokens = usage.input_tokens;
  if (typeof usage.output_tokens === "number") out.outputTokens = usage.output_tokens;
  // OpenAI shape
  if (typeof usage.prompt_tokens === "number") out.inputTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === "number") out.outputTokens = usage.completion_tokens;
  return out;
}

export function snapshot(): {
  startedAt: string;
  totals: Totals;
  byBackend: Record<string, Totals>;
  models: ModelStat[];
} {
  const totals: Totals = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, estCostUsd: 0 };
  const byBackend: Record<string, Totals> = {};
  const models = [...stats.values()].sort(
    (a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
  );
  for (const s of models) {
    // Recompute estimated cost from current prices each snapshot.
    s.estCostUsd = estimateCost(s.backend, s.model, s.inputTokens, s.outputTokens);
    totals.requests += s.requests;
    totals.errors += s.errors;
    totals.inputTokens += s.inputTokens;
    totals.outputTokens += s.outputTokens;
    if (s.estCostUsd != null) totals.estCostUsd += s.estCostUsd;
    const b = (byBackend[s.backend] ??= {
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      estCostUsd: 0,
    });
    b.requests += s.requests;
    b.errors += s.errors;
    b.inputTokens += s.inputTokens;
    b.outputTokens += s.outputTokens;
    if (s.estCostUsd != null) b.estCostUsd += s.estCostUsd;
  }
  return { startedAt, totals, byBackend, models };
}
