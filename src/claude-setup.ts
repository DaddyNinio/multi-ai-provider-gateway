/**
 * One-command setup for pointing Claude Code at this gateway.
 *
 * Claude Code reads an `env` map from ~/.claude/settings.json and injects those
 * variables into its own process. We only need to set:
 *   - ANTHROPIC_BASE_URL  -> this gateway's URL
 *   - ANTHROPIC_AUTH_TOKEN -> any non-empty value (the gateway ignores it)
 *   - CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY -> "1" so /models lists the
 *     merged catalog from both providers.
 *
 * The existing settings file is MERGED (never blindly overwritten) and a
 * timestamped backup is written first, so the operation is always reversible.
 */
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { c } from "./ui.js";

const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");

export interface SetupOptions {
  /** Base URL Claude Code should talk to, e.g. http://localhost:9000 */
  baseUrl: string;
  /** Auth token to store; a random one is generated if omitted. */
  token?: string;
}

export interface SetupResult {
  settingsPath: string;
  backupPath: string | null;
  baseUrl: string;
  token: string;
  created: boolean;
}

/** Read and parse settings.json, tolerating a missing or malformed file. */
function readSettings(): { data: Record<string, unknown>; existed: boolean } {
  if (!existsSync(SETTINGS_PATH)) return { data: {}, existed: false };
  try {
    const raw = readFileSync(SETTINGS_PATH, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    return { data: parsed as Record<string, unknown>, existed: true };
  } catch (err) {
    throw new Error(
      `~/.claude/settings.json exists but is not valid JSON (${String(
        (err as Error).message,
      )}). Fix or move it, then retry.`,
    );
  }
}

/** Generate a URL-safe random token. */
export function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Merge gateway settings into Claude Code's config, backing up first.
 * Returns details for display. Throws on unrecoverable I/O/JSON errors.
 */
export function setupClaude(opts: SetupOptions): SetupResult {
  const token = opts.token?.trim() || generateToken();

  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });

  const { data, existed } = readSettings();

  // Back up any existing file before touching it.
  let backupPath: string | null = null;
  if (existed) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = `${SETTINGS_PATH}.bak.${stamp}`;
    copyFileSync(SETTINGS_PATH, backupPath);
  }

  // Merge into the existing env block, preserving all other keys.
  const env =
    typeof data.env === "object" && data.env !== null
      ? (data.env as Record<string, unknown>)
      : {};

  env.ANTHROPIC_BASE_URL = opts.baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = token;
  env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
  data.env = env;

  writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");

  return {
    settingsPath: SETTINGS_PATH,
    backupPath,
    baseUrl: opts.baseUrl,
    token,
    created: !existed,
  };
}

/** Human-friendly summary printed after a successful setup. */
export function describeSetup(r: SetupResult): string {
  const lines: string[] = [];
  lines.push(
    `${c.green("✓")} ${c.bold("Claude Code is now pointed at this gateway.")}`,
  );
  lines.push("");
  lines.push(
    `${c.gray("settings")}  ${r.settingsPath}${r.created ? c.gray(" (created)") : ""}`,
  );
  if (r.backupPath) {
    lines.push(`${c.gray("backup  ")}  ${r.backupPath}`);
  }
  lines.push(`${c.gray("base url")}  ${c.cyan(r.baseUrl)}`);
  lines.push(`${c.gray("token   ")}  ${c.dim(r.token)}`);
  lines.push("");
  lines.push(`${c.gray("Next:")} run ${c.bold("claude")} and type ${c.bold("/models")}.`);
  return lines.join("\n");
}
