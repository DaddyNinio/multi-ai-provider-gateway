/**
 * Configuration for multi-ai-provider-gateway, loaded from environment variables.
 * This build talks DIRECTLY to GitHub Copilot and the Kiro/Amazon Q runtime —
 * there are no upstream gateway URLs to configure.
 */

export interface Config {
  /** Port this gateway listens on. */
  port: number;
  /** Prefix that namespaces copilot model ids (e.g. "copilot/"). */
  copilotPrefix: string;
  /** Prefix that namespaces kiro model ids (e.g. "kiro/"). */
  kiroPrefix: string;
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs: number;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 9000),
    copilotPrefix: process.env.COPILOT_PREFIX ?? "copilot/",
    kiroPrefix: process.env.KIRO_PREFIX ?? "kiro/",
    requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS ?? 600000),
  };
}
