#!/usr/bin/env node
/**
 * Entry point: load .env, build config, and start the HTTP server.
 */
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createApp } from "./server.js";

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

loadDotEnv();
const cfg = loadConfig();

const app = createApp(cfg);
serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  console.log(`unified-ai-gateway listening on http://localhost:${info.port}`);
  console.log(`  dashboard -> http://localhost:${info.port}/dashboard`);
  console.log(`  providers -> kiro (runtime.kiro.dev) + copilot (githubcopilot.com), in-process`);
  console.log(`  copilot models are prefixed "${cfg.copilotPrefix}"`);
});
