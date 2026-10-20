/**
 * Provider authentication flows.
 *
 * Copilot: original implementation of GitHub's OAuth device-code flow
 *   (RFC 8628). The resulting GitHub token is saved to the same file the
 *   Copilot provider reads, so a successful login immediately enables Copilot.
 *
 * Kiro: login is an AWS SSO flow owned by the `kiro` CLI. We launch
 *   `kiro login` for the user (if the binary is present) and report when the
 *   gateway can see valid credentials afterwards.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Well-known GitHub Copilot OAuth client (public identifier, not a secret).
const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const GITHUB_SCOPE = "read:user";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_TOKEN_PATH = join(homedir(), ".local/share/copilot-api/github_token");

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export type AuthState =
  | { status: "idle" }
  | { status: "pending"; userCode: string; verificationUri: string; expiresAt: number }
  | { status: "authorized"; message: string }
  | { status: "error"; message: string };

const copilotState: { current: AuthState } = { current: { status: "idle" } };
const kiroState: { current: AuthState } = { current: { status: "idle" } };

export function getCopilotAuthState(): AuthState {
  return copilotState.current;
}
export function getKiroAuthState(): AuthState {
  return kiroState.current;
}

const jsonHeaders = {
  "content-type": "application/json",
  accept: "application/json",
  "user-agent": "multi-ai-provider-gateway",
};

/**
 * Begin the Copilot (GitHub) device-code login. Returns the user code and
 * verification URL to display, and polls in the background until the user
 * authorizes (or the code expires). On success the GitHub token is persisted.
 */
export async function startCopilotAuth(): Promise<AuthState> {
  if (copilotState.current.status === "pending") return copilotState.current;

  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: GITHUB_SCOPE }),
  });
  if (!res.ok) {
    copilotState.current = { status: "error", message: `device code request failed: ${res.status}` };
    return copilotState.current;
  }
  const device = (await res.json()) as DeviceCodeResponse;

  copilotState.current = {
    status: "pending",
    userCode: device.user_code,
    verificationUri: device.verification_uri,
    expiresAt: Date.now() + device.expires_in * 1000,
  };

  // Background poll — do not await.
  void pollCopilot(device);
  return copilotState.current;
}

async function pollCopilot(device: DeviceCodeResponse): Promise<void> {
  const expiresAt = Date.now() + device.expires_in * 1000;
  let intervalMs = (device.interval + 1) * 1000;

  while (Date.now() < expiresAt) {
    await new Promise((r) => setTimeout(r, intervalMs));
    let json: Record<string, unknown>;
    try {
      const res = await fetch(ACCESS_TOKEN_URL, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: device.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
      if (!res.ok) continue;
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      continue; // transient; keep polling until expiry
    }

    const token = json["access_token"];
    const error = json["error"];
    if (typeof token === "string" && token) {
      try {
        await mkdir(dirname(GITHUB_TOKEN_PATH), { recursive: true });
        await writeFile(GITHUB_TOKEN_PATH, token, "utf8");
        await chmod(GITHUB_TOKEN_PATH, 0o600);
        copilotState.current = { status: "authorized", message: "GitHub Copilot authorized" };
      } catch (e) {
        copilotState.current = { status: "error", message: `failed to save token: ${String(e)}` };
      }
      return;
    }
    if (error === "slow_down") {
      intervalMs += 5000;
    } else if (error && error !== "authorization_pending") {
      copilotState.current = {
        status: "error",
        message: `authorization failed: ${String(json["error_description"] ?? error)}`,
      };
      return;
    }
  }
  copilotState.current = { status: "error", message: "device code expired; start again" };
}

/**
 * Launch the Kiro login (AWS SSO) via the `kiro` CLI. The actual browser SSO
 * flow is owned by that CLI; we start it and report status. If `kiro` is not
 * installed, return guidance instead.
 */
export function startKiroAuth(): AuthState {
  try {
    const child = spawn("kiro", ["login"], { stdio: "ignore", detached: true });
    child.on("error", () => {
      kiroState.current = {
        status: "error",
        message: "`kiro` CLI not found. Install it and run `kiro login`, then retry.",
      };
    });
    child.unref();
    kiroState.current = {
      status: "pending",
      userCode: "—",
      verificationUri: "a `kiro login` window/terminal was opened; complete the AWS SSO sign-in",
      expiresAt: Date.now() + 10 * 60 * 1000,
    };
  } catch {
    kiroState.current = {
      status: "error",
      message: "could not launch `kiro login`. Run it manually, then retry.",
    };
  }
  return kiroState.current;
}

/** Mark Kiro authorized if credentials are now resolvable (called by /auth/kiro/status). */
export function markKiroAuthorized(ok: boolean): AuthState {
  if (ok) kiroState.current = { status: "authorized", message: "Kiro authorized" };
  return kiroState.current;
}
