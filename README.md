<div align="center">

# multi-ai-provider-gateway

**One Anthropic/OpenAI-compatible endpoint. Every model from GitHub Copilot and Kiro / Amazon Q.**

[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Self-contained](https://img.shields.io/badge/deps-no%20external%20gateway-7ee787)](#how-it-is-self-contained)

</div>

---

Point **Claude Code** — or any Anthropic/OpenAI client — at one local server and
get the **union of both providers' model catalogs** in a single `/v1/models`
list, each request routed to the right backend by model name, with a live
token &amp; credits dashboard. All code here is **original and self-contained**:
it talks **directly** to each provider's real backend and does not run, embed,
or depend on any third-party gateway server.

- **Kiro / Amazon Q** — Claude models plus the GLM open-weight model via
  `runtime.kiro.dev`
- **GitHub Copilot** — the full Copilot catalog via `api.githubcopilot.com`

```
                       ┌───────────────────────────────┐
  Claude Code  ─────▶  │  multi-ai-provider-gateway     │  :9000
  (or any client)      │  /v1/models                    │
                       │  /v1/messages                  │
                       │  /v1/chat/completions          │
                       │  /dashboard  /stats  /credits  │
                       └──────┬───────────────┬─────────┘
            kiro/<id>         │               │   copilot/<id>
                              ▼               ▼
          runtime.kiro.dev (direct)   api.githubcopilot.com (direct)
          [src/providers/kiro.ts]     [src/providers/copilot.ts]
```

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Authentication](#authentication)
- [Use with Claude Code](#use-with-claude-code)
- [CLI options](#cli-options)
- [Configuration](#configuration)
- [Endpoints](#endpoints)
- [Routing rules](#routing-rules)
- [Reasoning effort](#reasoning-effort)
- [Monitoring](#monitoring)
- [How it is self-contained](#how-it-is-self-contained)
- [Requirements](#requirements)
- [Credits](#credits)
- [License](#license)

## Features

- 🔀 **One endpoint, two providers** — merged `/v1/models`, routed by model name.
- 🏷️ **Namespaced models** — `kiro/...` vs `copilot/...` so you can tell them
  apart at a glance in any model picker.
- 🔁 **Protocol translation** — Anthropic ⇄ OpenAI both ways, so a Copilot model
  works through `/v1/messages` and a Kiro model through `/v1/chat/completions`.
- ⚡ **One-command Claude Code setup** — safely writes `~/.claude/settings.json`
  (merges + backs up first).
- 🔐 **Built-in auth** — GitHub Copilot device-code login from the dashboard;
  Kiro login launcher.
- 📊 **Live dashboard** — per-provider and per-model requests, errors, and
  input/output token totals, plus credits/quota.
- 📦 **Zero external gateway** — original TypeScript, talks straight to each
  backend. Run it with `npx`, no clone required.

## Quick start

```bash
npm install
npm start
# opens on http://localhost:9000  ·  dashboard at /dashboard
# on first run it offers to configure Claude Code for you
```

Run it straight from GitHub with no clone:

```bash
npx github:DaddyNinio/multi-ai-provider-gateway
```

Compiled build:

```bash
npm run build && npm run serve
```

You can run with just one provider authenticated — the gateway serves whatever
is available.

## Authentication

Sign in to each provider once. Credentials are read from the same files the
official tools use, so you can authenticate however you like:

- **From the terminal** (built in):

  ```bash
  npm run login                 # sign in to both providers
  multi-ai-provider-gateway --login copilot   # just GitHub Copilot
  multi-ai-provider-gateway --login kiro      # just Kiro / Amazon Q
  ```

  `--login copilot` runs GitHub's device-code flow (shows a code + URL and waits
  until you authorize). `--login kiro` launches `kiro login` (AWS SSO) and waits
  until the gateway can see valid credentials.

- **From the dashboard** — open `/dashboard` and click **Connect** next to a
  provider that isn't authenticated yet.

- **Manually** — drop a GitHub token at `~/.local/share/copilot-api/github_token`
  (or set `GITHUB_TOKEN`), and run `kiro login` for Kiro.

You can run with just one provider authenticated; the gateway serves whatever is
available.

## Use with Claude Code

The easiest path is to let the gateway configure Claude Code for you. It writes
`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and
`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` into `~/.claude/settings.json`,
**merging** with your existing settings and saving a timestamped backup first,
so the change is always reversible.

```bash
# One-shot: configure Claude Code, then exit
npm run setup-claude
# or
multi-ai-provider-gateway --setup-claude
```

Just starting the server also **offers to configure Claude Code** interactively
the first time:

```bash
npm start
# ◆ multi-ai-provider-gateway  http://localhost:9000
# Configure Claude Code to use this gateway now? [Y/n]
```

Then run Claude Code and pick any model from either provider:

```bash
claude
# then type: /models  →  kiro/claude-opus-5, kiro/glm-5, copilot/gpt-4o, …
```

Prefer to set it yourself? Point Claude Code at the gateway manually:

```bash
ANTHROPIC_BASE_URL=http://localhost:9000 ANTHROPIC_AUTH_TOKEN=any-value claude
```

## CLI options

| Flag                 | Description                                                    |
| -------------------- | ------------------------------------------------------------- |
| `--login [provider]` | Sign in to a provider from the terminal: `copilot`, `kiro`, or `all` (default). |
| `--model [id]`       | Pick the active Claude Code model from the **full** catalog with an arrow-key picker (↑/↓, Enter; type to filter), or set `<id>` directly (e.g. `kiro/glm-5`), then exit. |
| `--setup-claude`     | Configure Claude Code to use this gateway, then exit.         |
| `--port, -p <n>`     | Port to listen on (default `9000`, or `$PORT`).               |
| `--token <value>`    | Auth token to write during setup (default: random, URL-safe). |
| `--no-setup-prompt`  | Skip the interactive "configure Claude Code?" prompt.         |
| `--yes, -y`          | Assume "yes" to prompts (non-interactive setup).              |
| `--help, -h`         | Show help.                                                    |

## Configuration

All optional — defaults work out of the box. See [`.env.example`](.env.example).

| Variable             | Default    | Description                             |
| -------------------- | ---------- | --------------------------------------- |
| `PORT`               | `9000`     | Port this gateway listens on.           |
| `COPILOT_PREFIX`     | `copilot/` | Namespace applied to Copilot model ids. |
| `KIRO_PREFIX`        | `kiro/`    | Namespace applied to Kiro model ids.    |
| `REQUEST_TIMEOUT_MS` | `600000`   | Per-request timeout (ms).               |
| `GITHUB_TOKEN`       | *(file)*   | Override the GitHub OAuth token.        |

## Endpoints

| Method | Path                   | Description                                                        |
| ------ | ---------------------- | ----------------------------------------------------------------- |
| `GET`  | `/health`              | Reports which providers are authenticated.                        |
| `GET`  | `/v1/models`           | Merged catalog. Kiro ids prefixed `kiro/`; Copilot ids `copilot/`. |
| `POST` | `/v1/messages`         | Anthropic Messages API. Routed by `model`.                        |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions API. Routed by `model`.                   |
| `GET`  | `/dashboard`           | Live credits &amp; token-usage monitor (HTML). Also at `/`.       |
| `GET`  | `/stats`               | JSON usage stats: tokens + estimated spend for the session.       |
| `GET`  | `/credits`             | Per-provider auth state, plan, and Copilot credits/quota usage.   |

## Routing rules

For a request's `model`:

1. starts with `COPILOT_PREFIX` (e.g. `copilot/gpt-4o`) → **Copilot** (prefix stripped)
2. starts with `KIRO_PREFIX` (e.g. `kiro/claude-opus-5`) → **Kiro** (prefix stripped)
3. a bare id that exists only in the Copilot catalog → **Copilot**
4. everything else → **Kiro** (bare ids still work, for backward compatibility)

So in a model picker you can tell them apart at a glance:
`kiro/claude-opus-5`, `kiro/glm-5` vs `copilot/gpt-4o`, `copilot/claude-sonnet-4`.

Cross-protocol calls are translated automatically (Anthropic ⇄ OpenAI), so a
Copilot model works through `/v1/messages` and a Kiro model works through
`/v1/chat/completions`.

## Reasoning effort

Many Copilot models support a reasoning-effort level. You can control it per
request, in either API shape:

- **OpenAI** — send `reasoning_effort` directly:

  ```json
  { "model": "copilot/gpt-6-sol", "reasoning_effort": "high",
    "messages": [{ "role": "user", "content": "…" }] }
  ```

- **Anthropic** — send a `thinking` block; the gateway maps the budget to an
  effort level:

  ```json
  { "model": "copilot/claude-opus-5", "max_tokens": 1024,
    "thinking": { "type": "enabled", "budget_tokens": 16000 },
    "messages": [{ "role": "user", "content": "…" }] }
  ```

  Budget → effort mapping: `≤4000` → `low`, `≤12000` → `medium`, `≤24000` →
  `high`, else `xhigh`. An explicit `reasoning_effort` always wins.

Effort is applied on the Copilot backend (whose models advertise
`reasoning_effort`). Kiro requests ignore it.

## Monitoring

Open **http://localhost:9000/dashboard** for a live view (auto-refreshes every
4s) of:

- **Totals** — requests, errors, input/output/total tokens, and estimated spend.
- **Per-provider usage** — the same metrics split for Kiro vs GitHub Copilot,
  each with its own estimated spend.
- **Credits &amp; quota** — per-provider credits usage.
  **Kiro** shows live credit usage from the same `GetUsageLimits` call the
  kiro-cli `/usage` panel uses: plan (e.g. KIRO PRO+), credits used / monthly
  limit with a progress bar, remaining balance, reset date, and overage
  used / rate / estimated cost.
  **Copilot** shows its plan, token expiry, quota reset date, and per-quota
  usage (`chat`, `completions`, `premium_interactions`) as **used / entitlement**
  with percent remaining. A **Connect** button (device-code login) appears for
  any provider not yet authenticated.
- **Per-model usage** — a table of counts, errors, tokens, and estimated spend
  per model.

Spend is **estimated** from Copilot's published per-model token prices
(`billing.token_prices`); Kiro has no per-token price, so its spend shows `—`.
Stats are in-memory and reset on restart.

## How it is self-contained

Everything runs from this one repo. The two providers are original TypeScript
modules — no external gateway process is started or required:

- **`src/providers/copilot.ts`** — reads your GitHub OAuth token, exchanges it
  for a Copilot token (cached + auto-refreshed), lists Copilot models, and calls
  Copilot's OpenAI-compatible chat API directly.
- **`src/providers/kiro.ts`** — reads your Kiro credentials from the kiro-cli
  database, calls the Amazon CodeWhisperer streaming runtime
  (`generateAssistantResponse`), and decodes its AWS event-stream response into
  clean Anthropic output.

These modules were written from scratch — inspired by how
[`jwadow/kiro-gateway`](https://github.com/jwadow/kiro-gateway) and
[`caozhiyuan/copilot-api`](https://github.com/caozhiyuan/copilot-api) work, but
containing none of their code.

## Requirements

- **Node.js ≥ 20** and the `sqlite3` CLI (ships with macOS).
- **GitHub Copilot** auth — a token at
  `~/.local/share/copilot-api/github_token` (or set `GITHUB_TOKEN`), or use the
  dashboard **Connect** button.
- **Kiro** auth — logged in via `kiro login` (creates the kiro-cli database).

## Credits

Original work, inspired by the designs of
[jwadow/kiro-gateway](https://github.com/jwadow/kiro-gateway) (AGPL-3.0) and
[caozhiyuan/copilot-api](https://github.com/caozhiyuan/copilot-api) (MIT). No
code from either project is included here.

## License

[MIT](LICENSE)
