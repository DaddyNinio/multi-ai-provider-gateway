#!/usr/bin/env node
/**
 * Entry point: parse CLI flags, optionally configure Claude Code, load .env,
 * build config, and start the HTTP server with a friendly startup UI.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createApp } from "./server.js";
import { health } from "./upstreams.js";
import { setupClaude, describeSetup } from "./claude-setup.js";
import { box, c, statusGlyph } from "./ui.js";

/** Minimal .env loader (no dependency): KEY=VALUE lines, # comments. */
function loadDotEnv(path = ".env"): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // no .env is fine; rely on real env vars
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

interface CliArgs {
  help: boolean;
  setupClaude: boolean;
  noSetupPrompt: boolean;
  yes: boolean;
  port?: number;
  token?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    help: false,
    setupClaude: false,
    noSetupPrompt: false,
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--setup-claude":
      case "--setup":
        args.setupClaude = true;
        break;
      case "--no-setup-prompt":
        args.noSetupPrompt = true;
        break;
      case "-y":
      case "--yes":
        args.yes = true;
        break;
      case "--port":
      case "-p":
        args.port = Number(argv[++i]);
        break;
      case "--token":
        args.token = argv[++i];
        break;
      default:
        if (a.startsWith("--port=")) args.port = Number(a.slice("--port=".length));
        else if (a.startsWith("--token=")) args.token = a.slice("--token=".length);
    }
  }
  return args;
}

function printHelp(): void {
  const name = c.bold("multi-ai-provider-gateway");
  const lines = [
    `${name} — one Anthropic/OpenAI-compatible endpoint for Kiro + GitHub Copilot`,
    "",
    c.bold("USAGE"),
    `  multi-ai-provider-gateway [options]`,
    "",
    c.bold("OPTIONS"),
    `  ${c.cyan("--setup-claude")}       Configure Claude Code to use this gateway, then exit`,
    `  ${c.cyan("--port, -p <n>")}       Port to listen on (default 9000, or $PORT)`,
    `  ${c.cyan("--token <value>")}      Auth token to write during setup (default: random)`,
    `  ${c.cyan("--no-setup-prompt")}    Skip the interactive "configure Claude Code?" prompt`,
    `  ${c.cyan("--yes, -y")}            Assume "yes" to prompts (non-interactive setup)`,
    `  ${c.cyan("--help, -h")}           Show this help`,
    "",
    c.bold("EXAMPLES"),
    `  ${c.gray("# Start the server (prompts to configure Claude Code the first time)")}`,
    `  multi-ai-provider-gateway`,
    "",
    `  ${c.gray("# Just configure Claude Code and exit")}`,
    `  multi-ai-provider-gateway --setup-claude`,
    "",
    `  ${c.gray("# Start on a custom port, no prompts")}`,
    `  multi-ai-provider-gateway -p 9100 --no-setup-prompt`,
  ];
  console.log("\n" + lines.join("\n") + "\n");
}

/** Ask a yes/no question; returns the default when input is not a TTY. */
async function confirm(question: string, def = true): Promise<boolean> {
  if (!process.stdin.isTTY) return def;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hint = def ? "[Y/n]" : "[y/N]";
    const ans = (await rl.question(`${question} ${c.gray(hint)} `)).trim().toLowerCase();
    if (!ans) return def;
    return ans === "y" || ans === "yes";
  } finally {
    rl.close();
  }
}

function baseUrlFor(port: number): string {
  return `http://localhost:${port}`;
}

/** Run the Claude Code setup and print the result. */
function doSetup(baseUrl: string, token?: string): void {
  try {
    const result = setupClaude({ baseUrl, token });
    console.log("\n" + box(describeSetup(result).split("\n"), {
      title: "Claude Code configured",
      borderColor: c.green,
    }) + "\n");
  } catch (err) {
    console.error(
      "\n" + box([`${c.red("✗")} ${String((err as Error).message)}`], {
        title: "Setup failed",
        borderColor: c.red,
      }) + "\n",
    );
    process.exitCode = 1;
  }
}

/** Render the startup banner with live provider status. */
async function printBanner(port: number): Promise<void> {
  const base = baseUrlFor(port);
  let kiroOk = false;
  let copilotOk = false;
  try {
    const cfg = loadConfig();
    const h = await health(cfg);
    kiroOk = h.kiro;
    copilotOk = h.copilot;
  } catch {
    // health probe best-effort only
  }

  const title = `${c.brightCyan("◆")} multi-ai-provider-gateway`;
  const lines = [
    `${c.gray("server    ")} ${c.cyan(base)}`,
    `${c.gray("dashboard ")} ${c.cyan(base + "/dashboard")}`,
    "",
    `${c.gray("providers")}`,
    `  ${statusGlyph(kiroOk ? "ok" : "off")} kiro      ${kiroOk ? c.green("authenticated") : c.gray("not signed in — open the dashboard to connect")}`,
    `  ${statusGlyph(copilotOk ? "ok" : "off")} copilot   ${copilotOk ? c.green("authenticated") : c.gray("not signed in — open the dashboard to connect")}`,
    "",
    `${c.gray("use with Claude Code")}`,
    `  ${c.dim("run")} ${c.bold("claude")} ${c.dim("then")} ${c.bold("/models")}  ${c.gray("(after --setup-claude)")}`,
    `  ${c.dim("or:")} ${c.gray(`ANTHROPIC_BASE_URL=${base} ANTHROPIC_AUTH_TOKEN=any claude`)}`,
  ];

  console.log("\n" + box(lines, { title, borderColor: c.cyan }) + "\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  loadDotEnv();

  // Resolve port: CLI flag > env/.env > default.
  if (args.port && Number.isFinite(args.port)) {
    process.env.PORT = String(args.port);
  }
  const cfg = loadConfig();
  const base = baseUrlFor(cfg.port);

  // Setup-only mode: configure Claude Code and exit.
  if (args.setupClaude) {
    doSetup(base, args.token);
    return;
  }

  // Start the server.
  const app = createApp(cfg);
  serve({ fetch: app.fetch, port: cfg.port }, async (info) => {
    await printBanner(info.port);

    // Offer to configure Claude Code (interactive, once per run).
    if (!args.noSetupPrompt) {
      if (args.yes) {
        doSetup(baseUrlFor(info.port), args.token);
      } else if (process.stdin.isTTY) {
        const wanted = await confirm(
          `${c.bold("Configure Claude Code")} to use this gateway now?`,
          true,
        );
        if (wanted) doSetup(baseUrlFor(info.port), args.token);
        else
          console.log(
            c.gray(
              `  Skipped. Run ${c.bold("--setup-claude")} anytime to configure it later.\n`,
            ),
          );
      } else {
        console.log(
          c.gray(
            `  Tip: run ${c.bold("--setup-claude")} to point Claude Code at this gateway.\n`,
          ),
        );
      }
    }

    console.log(c.gray(`  Ready. Press Ctrl+C to stop.`));
  });
}

void main();
