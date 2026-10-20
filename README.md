# multi-ai-provider-gateway

A single **Anthropic/OpenAI-compatible** gateway that exposes the models of two
providers behind one endpoint — with **all code original and self-contained**.
It talks **directly** to each provider's real backend; it does not run, embed,
or depend on any third-party gateway server.

- **Kiro / Amazon Q** — Claude and GLM models via `runtime.kiro.dev`
- **GitHub Copilot** — the full Copilot model catalog via `api.githubcopilot.com`

Point Claude Code (or any Anthropic/OpenAI client) at this one server and you
get the union of both providers' models in a single `/v1/models` list, routed to
the right backend by model name, plus a live token/credits dashboard.

```
                       ┌───────────────────────────────┐
  Claude Code  ─────▶  │  multi-ai-provider-gateway     │  :9000
  (or any client)      │  /v1/models                    │
                       │  /v1/messages                  │
                       │  /v1/chat/completions          │
                       │  /dashboard  /stats            │
                       └──────┬───────────────┬─────────┘
             kiro model id    │               │   copilot/<id> or known copilot id
                              ▼               ▼
          runtime.kiro.dev (direct)   api.githubcopilot.com (direct)
          [src/providers/kiro.ts]     [src/providers/copilot.ts]
```

## How it is self-contained

Everything runs from this one repo. The two providers are implemented here as
original TypeScript modules:

- **`src/providers/copilot.ts`** — reads your GitHub OAuth token, exchanges it
  for a Copilot token (cached + auto-refreshed), lists Copilot models, and calls
  Copilot's OpenAI-compatible chat API directly.
- **`src/providers/kiro.ts`** — reads your Kiro credentials from the kiro-cli
  database, calls the Amazon CodeWhisperer streaming runtime
  (`generateAssistantResponse`), and decodes its AWS event-stream response into
  clean Anthropic output.

No external gateway process is started or required. These modules were written
from scratch (inspired by how `jwadow/kiro-gateway` and `caozhiyuan/copilot-api`
work, but containing none of their code).

## Requirements

- Node.js >= 20, and the `sqlite3` CLI (ships with macOS).
- **GitHub Copilot** auth: a token at `~/.local/share/copilot-api/github_token`
  (or set `GITHUB_TOKEN`).
- **Kiro** auth: logged in via `kiro login` (creates the kiro-cli database).

You can run with just one provider configured; the gateway serves whatever is
authenticated.

## Quick start

```bash
npm install
npm start
# open http://localhost:9000/dashboard
# on first run it offers to configure Claude Code for you
```

Or run it straight from GitHub with no clone:

```bash
npx github:DaddyNinio/multi-ai-provider-gateway
```

### Compiled build

```bash
npm run build && npm run serve
```

## Configuration

All optional — defaults work out of the box. See `.env.example`.

| Variable             | Default      | Description                                  |
| -------------------- | ------------ | -------------------------------------------- |
| `PORT`               | `9000`       | Port this gateway listens on.                |
| `COPILOT_PREFIX`     | `copilot/`   | Namespace applied to Copilot model ids.      |
| `KIRO_PREFIX`        | `kiro/`      | Namespace applied to Kiro model ids.         |
| `REQUEST_TIMEOUT_MS` | `600000`     | Per-request timeout (ms).                    |
| `GITHUB_TOKEN`       | *(file)*     | Override the GitHub OAuth token.             |

## Endpoints

| Method | Path                   | Description                                                      |
| ------ | ---------------------- | ---------------------------------------------------------------- |
| `GET`  | `/health`              | Reports which providers are authenticated.                       |
| `GET`  | `/v1/models`           | Merged catalog. Kiro ids prefixed `kiro/`; Copilot ids `copilot/`. |
| `POST` | `/v1/messages`         | Anthropic Messages API. Routed by `model`.                       |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions API. Routed by `model`.                  |
| `GET`  | `/dashboard`           | Live credits &amp; token-usage monitor (HTML). Also at `/`.      |
| `GET`  | `/stats`               | JSON token-usage stats for the current session.                  |
| `GET`  | `/credits`             | Which providers are authenticated.                               |

### Routing rules

For a request's `model`:

1. starts with `COPILOT_PREFIX` (e.g. `copilot/gpt-4o`) → **Copilot** (prefix stripped)
2. starts with `KIRO_PREFIX` (e.g. `kiro/claude-opus-5`) → **Kiro** (prefix stripped)
3. a bare id that exists only in the Copilot catalog → **Copilot**
4. everything else → **Kiro** (bare ids still work, for backward compatibility)

So in a client's model picker you can tell them apart at a glance:
`kiro/claude-opus-5`, `kiro/glm-5` vs `copilot/gpt-4o`, `copilot/claude-sonnet-4`.

Cross-protocol calls are translated automatically (Anthropic↔OpenAI), so a
Copilot model works through `/v1/messages` and a Kiro model works through
`/v1/chat/completions`.

## Monitoring

Open **http://localhost:9000/dashboard** for a live view (auto-refreshes every
4s) of per-model request counts, errors, and input/output token totals, plus
which providers are authenticated. Stats are in-memory and reset on restart.

## Use with Claude Code

The easiest way is to let the gateway configure Claude Code for you. It writes
`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and
`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` into `~/.claude/settings.json`,
**merging** with your existing settings and saving a timestamped backup first.

```bash
# One-shot: configure Claude Code, then exit
npm run setup-claude
# or
multi-ai-provider-gateway --setup-claude
```

When you simply start the server it also **offers to configure Claude Code**
interactively the first time:

```bash
npm start
# ◆ multi-ai-provider-gateway  http://localhost:9000
# Configure Claude Code to use this gateway now? [Y/n]
```

After that, just run Claude Code and pick any model from both providers:

```bash
claude
# then type: /models
```

Prefer to set it yourself? Point Claude Code at the gateway manually:

```bash
ANTHROPIC_BASE_URL=http://localhost:9000 ANTHROPIC_AUTH_TOKEN=any-value claude
```

### CLI options

| Flag                 | Description                                                       |
| -------------------- | ---------------------------------------------------------------- |
| `--setup-claude`     | Configure Claude Code to use this gateway, then exit.            |
| `--port, -p <n>`     | Port to listen on (default `9000`, or `$PORT`).                  |
| `--token <value>`    | Auth token to write during setup (default: random, URL-safe).    |
| `--no-setup-prompt`  | Skip the interactive "configure Claude Code?" prompt.            |
| `--yes, -y`          | Assume "yes" to prompts (non-interactive setup).                 |
| `--help, -h`         | Show help.                                                       |


## Credits

Original work, inspired by the designs of
[jwadow/kiro-gateway](https://github.com/jwadow/kiro-gateway) (AGPL-3.0) and
[caozhiyuan/copilot-api](https://github.com/caozhiyuan/copilot-api) (MIT). No
code from either project is included here.

## License

MIT
