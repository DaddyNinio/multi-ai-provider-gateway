/**
 * Model aggregation and routing across the two in-process providers:
 *   - kiro     (src/providers/kiro.ts)     — Claude/GLM via the Kiro runtime
 *   - copilot  (src/providers/copilot.ts)  — GitHub Copilot catalog
 */
import type { Config } from "./config.js";
import * as copilot from "./providers/copilot.js";
import * as kiro from "./providers/kiro.js";
import { setCopilotPriceFromBilling } from "./pricing.js";

export interface ModelEntry {
  id: string;
  object: string;
  owned_by: string;
  [k: string]: unknown;
}

export type Backend = "kiro-gateway" | "copilot-api";

/** Plain copilot model ids (without prefix), learned from the last listing. */
const copilotModelIds = new Set<string>();

/**
 * Keep only chat-usable Copilot models. Copilot's /models catalog also returns
 * embedding models and other non-chat utilities; those can't serve chat/messages
 * requests. We treat `capabilities.type === "chat"` as the keeper, but fall back
 * to keeping the model when the field is absent (forward-compatible).
 */
function isChatModel(m: { id: string; capabilities?: unknown }): boolean {
  const caps = m.capabilities;
  if (caps && typeof caps === "object" && "type" in caps) {
    return (caps as { type?: unknown }).type === "chat";
  }
  return true; // unknown shape — don't hide it
}

/** Build the merged /v1/models catalog from both providers. */
export async function getMergedModels(cfg: Config): Promise<ModelEntry[]> {
  const merged: ModelEntry[] = [];

  // Kiro models (static list) — namespaced with the kiro prefix so they are
  // visually distinct from Copilot models in a client's model picker.
  // Non-Claude Kiro models are exposed under a "claude-"-prefixed display alias
  // (see kiro.listDisplayModels) so clients that only show Claude-family models
  // in their picker — e.g. Claude Code's gateway discovery — still list them.
  for (const m of kiro.listDisplayModels()) {
    merged.push({ id: `${cfg.kiroPrefix}${m.id}`, object: "model", owned_by: "kiro-gateway" });
  }

  // Copilot models (live) — namespaced with the prefix. Failures are tolerated
  // so the gateway still serves kiro if Copilot auth is unavailable.
  // We keep only chat-capable models (Copilot's catalog also includes
  // embeddings / non-chat utility models, which aren't usable here).
  try {
    const cModels = await copilot.listModels();
    copilotModelIds.clear();
    const seen = new Set<string>();
    for (const m of cModels) {
      if (!m.id || seen.has(m.id)) continue;
      if (!isChatModel(m)) continue;
      seen.add(m.id);
      copilotModelIds.add(m.id);
      // Learn per-model pricing for spend estimation (best-effort).
      setCopilotPriceFromBilling(m.id, (m as { billing?: unknown }).billing);
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
 * - "kiro/<id>"               -> kiro (prefix stripped; display alias resolved)
 * - a known copilot plain id  -> copilot
 * - everything else           -> kiro (bare id; backward compatible)
 *
 * For kiro, a requested id may be a "claude-"-prefixed *display alias* of a
 * non-Claude model (see kiro.listDisplayModels / toRealModelId); we resolve it
 * back to the real runtime id before handing it to the provider.
 */
export function pickRoute(cfg: Config, model: string): Route {
  if (model.startsWith(cfg.copilotPrefix)) {
    return { backend: "copilot-api", model: model.slice(cfg.copilotPrefix.length) };
  }
  if (model.startsWith(cfg.kiroPrefix)) {
    const displayId = model.slice(cfg.kiroPrefix.length);
    return { backend: "kiro-gateway", model: kiro.toRealModelId(displayId) };
  }
  if (copilotModelIds.has(model)) {
    return { backend: "copilot-api", model };
  }
  return { backend: "kiro-gateway", model: kiro.toRealModelId(model) };
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
