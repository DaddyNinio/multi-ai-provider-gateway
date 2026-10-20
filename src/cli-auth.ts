/**
 * Terminal-based provider authentication. Thin CLI wrappers around the same
 * flows the dashboard uses (src/auth.ts), so `--login` from the command line
 * and the dashboard "Connect" buttons stay in sync.
 */
import {
  getCopilotAuthState,
  startCopilotAuth,
  startKiroAuth,
} from "./auth.js";
import * as copilot from "./providers/copilot.js";
import * as kiro from "./providers/kiro.js";
import { box, c } from "./ui.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True if Copilot credentials currently resolve. */
async function copilotAuthed(): Promise<boolean> {
  try {
    await copilot.getCopilotToken();
    return true;
  } catch {
    return false;
  }
}

/** True if Kiro credentials currently resolve. */
function kiroAuthed(): boolean {
  try {
    kiro.getKiroCredentials();
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the GitHub Copilot device-code login in the terminal. Prints the code and
 * URL, then polls until authorized, the code expires, or `timeoutMs` elapses.
 */
export async function loginCopilot(timeoutMs = 10 * 60 * 1000): Promise<boolean> {
  if (await copilotAuthed()) {
    console.log(c.green("✓ GitHub Copilot is already authenticated."));
    return true;
  }

  const state = await startCopilotAuth();
  if (state.status === "error") {
    console.error(c.red("✗ " + state.message));
    return false;
  }
  if (state.status === "pending") {
    console.log(
      "\n" +
        box(
          [
            `${c.bold("Authorize GitHub Copilot")}`,
            "",
            `1. open   ${c.cyan(state.verificationUri)}`,
            `2. enter  ${c.bold(c.brightGreen(state.userCode))}`,
            "",
            c.gray("waiting for you to authorize…"),
          ],
          { title: "GitHub Copilot login", borderColor: c.cyan },
        ) +
        "\n",
    );
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2500);
    const s = getCopilotAuthState();
    if (s.status === "authorized") {
      console.log(c.green("✓ GitHub Copilot authorized."));
      return true;
    }
    if (s.status === "error") {
      console.error(c.red("✗ " + s.message));
      return false;
    }
    // Also detect success via credential resolution (token file written).
    if (await copilotAuthed()) {
      console.log(c.green("✓ GitHub Copilot authorized."));
      return true;
    }
  }
  console.error(c.red("✗ timed out waiting for Copilot authorization."));
  return false;
}

/**
 * Launch the Kiro (AWS SSO) login via the `kiro` CLI and wait until the
 * gateway can see valid credentials.
 */
export async function loginKiro(timeoutMs = 10 * 60 * 1000): Promise<boolean> {
  if (kiroAuthed()) {
    console.log(c.green("✓ Kiro is already authenticated."));
    return true;
  }

  const state = startKiroAuth();
  if (state.status === "error") {
    console.error(c.red("✗ " + state.message));
    console.log(c.gray("  Run `kiro login` manually, then re-run this command."));
    return false;
  }
  console.log(
    "\n" +
      box(
        [
          `${c.bold("Signing in to Kiro / Amazon Q")}`,
          "",
          c.gray("A `kiro login` AWS SSO flow was launched in your browser/terminal."),
          c.gray("Complete the sign-in there; this will finish automatically."),
        ],
        { title: "Kiro login", borderColor: c.cyan },
      ) +
      "\n",
  );

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2500);
    if (kiroAuthed()) {
      console.log(c.green("✓ Kiro authorized."));
      return true;
    }
  }
  console.error(c.red("✗ timed out waiting for Kiro sign-in."));
  return false;
}

export type LoginTarget = "copilot" | "kiro" | "all";

/** Run login for one or both providers. Returns true if all requested succeeded. */
export async function login(target: LoginTarget): Promise<boolean> {
  if (target === "copilot") return loginCopilot();
  if (target === "kiro") return loginKiro();
  // all: attempt both, report combined result.
  const copilotOk = await loginCopilot();
  const kiroOk = await loginKiro();
  return copilotOk && kiroOk;
}
