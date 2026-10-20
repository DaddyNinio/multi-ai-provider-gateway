/**
 * Model aggregation and routing across the two in-process providers:
 *   - kiro     (src/providers/kiro.ts)     — Claude/GLM via the Kiro runtime
 *   - copilot  (src/providers/copilot.ts)  — GitHub Copilot catalog
 */
import type { Config } from "./config.js";
import * as copilot from "./providers/copilot.js";
import * as kiro from "./providers/kiro.js";

export interface ModelEntry {
  id: string;
  object: string;
  owned_by: string;
  [k: string]: unknown;
}

export type Backend = "kiro-gateway" | "copilot-api";

/** Plain copilot model ids (without prefix), learned from the last listing. */
const copilotModelIds = new Set<string>();

/** Build the merged /v1/models catalog from both providers. */
export async function getMergedModels(cfg: Config): Promise<ModelEntry[]> {
  const merged: ModelEntry[] = [];

  // Kiro models (static list) — ids as-is.
  for (const m of kiro.listModels()) {
    merged.push({ id: m.id, object: "model", owned_by: "kiro-gateway" });
  }

  // Copilot models (live) — namespaced with the prefix. Failures are tolerated
  // so the gateway still serves kiro if Copilot auth is unavailable.
  try {
    const cModels = await copilot.listModels();
    copilotModelIds.clear();
    for (const m of cModels) {
      if (!m.id) continue;
      copilotModelIds.add(m.id);
      merged.push({ id: `${cfg.copilotPrefix}${m.id}`, object: "model", owned_by: "copilot-api" });
    }
  } catch {
    // Copilot unavailable — serve kiro-only.
  }

  return merged;
}

export interface Route {
  backend: Backend;
  /** The model id to pass to the provider (prefix stripped for copilot). */
  model: string;
}

/**
 * Decide which provider handles a requested model id.
 * - "copilot/<id>"            -> copilot (prefix stripped)
 * - a known copilot plain id  -> copilot
 * - everything else           -> kiro
 */
export function pickRoute(cfg: Config, model: string): Route {
  if (model.startsWith(cfg.copilotPrefix)) {
    return { backend: "copilot-api", model: model.slice(cfg.copilotPrefix.length) };
  }
  if (copilotModelIds.has(model)) {
    return { backend: "copilot-api", model };
  }
  return { backend: "kiro-gateway", model };
}

/** Probe each provider's basic availability for /health. */
export async function health(cfg: Config): Promise<{ kiro: boolean; copilot: boolean }> {
  const kiroOk = (() => {
    try {
      kiro.getKiroCredentials();
      return true;
    } catch {
      return false;
    }
  })();
  let copilotOk = false;
  try {
    await copilot.getCopilotToken();
    copilotOk = true;
  } catch {
    copilotOk = false;
  }
  return { kiro: kiroOk, copilot: copilotOk };
}
