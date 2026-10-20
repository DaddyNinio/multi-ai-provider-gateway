/**
 * Upstream model aggregation and request routing.
 */
import { authHeader, type Config, type UpstreamConfig } from "./config.js";

export interface ModelEntry {
  id: string;
  object?: string;
  owned_by?: string;
  [k: string]: unknown;
}

/** Which copilot model ids exist upstream (plain ids, no prefix). */
const copilotModelIds = new Set<string>();

async function fetchModels(up: UpstreamConfig): Promise<ModelEntry[]> {
  try {
    const res = await fetch(`${up.url}/v1/models`, {
      headers: authHeader(up.key),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: ModelEntry[] };
    return Array.isArray(json.data) ? json.data : [];
  } catch {
    return [];
  }
}

/**
 * Build the merged /v1/models catalog. Kiro models keep their ids; copilot
 * models are namespaced with the configured prefix so the two never collide.
 */
export async function getMergedModels(cfg: Config): Promise<ModelEntry[]> {
  const [kiro, copilot] = await Promise.all([
    fetchModels(cfg.kiro),
    fetchModels(cfg.copilot),
  ]);

  const merged: ModelEntry[] = [];

  for (const m of kiro) {
    if (!m.id) continue;
    merged.push({ ...m, owned_by: cfg.kiro.name });
  }

  copilotModelIds.clear();
  for (const m of copilot) {
    if (!m.id) continue;
    copilotModelIds.add(m.id);
    merged.push({ ...m, id: `${cfg.copilotPrefix}${m.id}`, owned_by: cfg.copilot.name });
  }

  return merged;
}

export interface Route {
  upstream: UpstreamConfig;
  /** Model id to forward to the upstream (prefix stripped). */
  forwardModel: string;
}

/**
 * Pick the upstream for a requested model id.
 * - "copilot/<id>"            -> copilot-api (prefix stripped)
 * - a known copilot plain id  -> copilot-api
 * - anything else             -> kiro-gateway
 */
export function pickRoute(cfg: Config, model: string): Route {
  if (model.startsWith(cfg.copilotPrefix)) {
    return { upstream: cfg.copilot, forwardModel: model.slice(cfg.copilotPrefix.length) };
  }
  if (copilotModelIds.has(model)) {
    return { upstream: cfg.copilot, forwardModel: model };
  }
  return { upstream: cfg.kiro, forwardModel: model };
}

/** Lightweight reachability probe for /health. */
export async function probe(up: UpstreamConfig): Promise<boolean> {
  for (const path of ["/health", "/v1/models"]) {
    try {
      const res = await fetch(`${up.url}${path}`, {
        headers: authHeader(up.key),
        signal: AbortSignal.timeout(3_000),
      });
      if (res.status < 500) return true;
    } catch {
      // try next path
    }
  }
  return false;
}
