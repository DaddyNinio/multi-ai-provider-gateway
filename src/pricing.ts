/**
 * Cost estimation for tracked usage.
 *
 * GitHub Copilot's /models catalog exposes `billing.token_prices.default` with
 * `input_price` / `output_price` expressed in **US cents per 1,000,000 tokens**
 * (e.g. input_price 500 → $5.00 per million input tokens). We learn those
 * prices from the live catalog and use them to estimate spend.
 *
 * Kiro / Amazon Q usage is billed under an Amazon Q / subscription plan and the
 * runtime does not return per-token prices, so Kiro spend is reported as
 * `null` (unknown) rather than guessed.
 */

export interface ModelPrice {
  /** USD per input token. */
  inputPerToken: number;
  /** USD per output token. */
  outputPerToken: number;
}

/** backend::model -> price. Only populated for providers that expose pricing. */
const priceMap = new Map<string, ModelPrice>();

function key(backend: string, model: string): string {
  return `${backend}::${model}`;
}

/**
 * Record pricing for a Copilot model from its catalog `billing` object.
 * Prices are converted from "cents per 1e6 tokens" to USD per token.
 * A zero/absent price is treated as "unknown" and not stored.
 */
export function setCopilotPriceFromBilling(modelId: string, billing: unknown): void {
  const prices = (billing as any)?.token_prices?.default;
  if (!prices || typeof prices !== "object") return;
  const input = Number(prices.input_price);
  const output = Number(prices.output_price);
  if (!input && !output) return; // all-zero → unknown/free tier; skip
  priceMap.set(key("copilot-api", modelId), {
    // cents per 1e6 tokens → USD per token: value / 100 / 1e6 = value / 1e8
    inputPerToken: (Number.isFinite(input) ? input : 0) / 1e8,
    outputPerToken: (Number.isFinite(output) ? output : 0) / 1e8,
  });
}

/** Look up a stored price for backend+model, if known. */
export function getPrice(backend: string, model: string): ModelPrice | undefined {
  return priceMap.get(key(backend, model));
}

/**
 * Estimate USD cost for a given token usage. Returns `null` when no price is
 * known for the model (e.g. Kiro), so the UI can show "—" instead of "$0".
 */
export function estimateCost(
  backend: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const p = getPrice(backend, model);
  if (!p) return null;
  return inputTokens * p.inputPerToken + outputTokens * p.outputPerToken;
}

/** Whether any pricing is known at all (used to decide if the UI shows spend). */
export function hasAnyPricing(): boolean {
  return priceMap.size > 0;
}
