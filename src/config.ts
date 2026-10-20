/**
 * Configuration for unified-ai-gateway, loaded from environment variables.
 * A .env file (if present) is loaded by main.ts before this is read.
 */

export interface UpstreamConfig {
  /** Short name used in logs and the owned_by field. */
  name: string;
  /** Base URL, no trailing slash. */
  url: string;
  /** Bearer key, or empty string for no auth. */
  key: string;
}

export interface Config {
  port: number;
  kiro: UpstreamConfig;
  copilot: UpstreamConfig;
  /** Prefix that namespaces copilot-api model ids (e.g. "copilot/"). */
  copilotPrefix: string;
  /** Per-request upstream timeout in milliseconds. */
  requestTimeoutMs: number;
}

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 9000),
    kiro: {
      name: "kiro-gateway",
      url: stripTrailingSlash(process.env.KIRO_GATEWAY_URL ?? "http://localhost:8000"),
      key: process.env.KIRO_GATEWAY_KEY ?? "",
    },
    copilot: {
      name: "copilot-api",
      url: stripTrailingSlash(process.env.COPILOT_API_URL ?? "http://localhost:4141"),
      key: process.env.COPILOT_API_KEY ?? "",
    },
    copilotPrefix: process.env.COPILOT_PREFIX ?? "copilot/",
    requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS ?? 600000),
  };
}

export function authHeader(key: string): Record<string, string> {
  return key ? { authorization: `Bearer ${key}` } : {};
}
