# unified-ai-gateway

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
                       ┌─────────────────────┐
  Claude Code  ─────▶  │ unified-ai-gateway  │  :9000
  (or any client)      │  /v1/models          │
                       │  /v1/messages         │
                       │  /v1/chat/completions │
                       │  /dashboard /stats    │
                       └──────┬───────┬────────┘
             kiro model id    │       │   copilot/<id> or known copilot id
                              ▼       ▼
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
```

Or run it straight from GitHub with no clone:

```bash
npx github:DaddyNinio/unified-ai-gateway
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
| `REQUEST_TIMEOUT_MS` | `600000`     | Per-request timeout (ms).                    |
| `GITHUB_TOKEN`       | *(file)*     | Override the GitHub OAuth token.             |

## Endpoints

| Method | Path                   | Description                                                      |
| ------ | ---------------------- | ---------------------------------------------------------------- |
| `GET`  | `/health`              | Reports which providers are authenticated.                       |
| `GET`  | `/v1/models`           | Merged catalog. Kiro ids as-is; Copilot ids prefixed.            |
| `POST` | `/v1/messages`         | Anthropic Messages API. Routed by `model`.                       |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions API. Routed by `model`.                  |
| `GET`  | `/dashboard`           | Live credits &amp; token-usage monitor (HTML). Also at `/`.      |
| `GET`  | `/stats`               | JSON token-usage stats for the current session.                  |
| `GET`  | `/credits`             | Which providers are authenticated.                               |

### Routing rules

For a request's `model`:

1. starts with `COPILOT_PREFIX` (e.g. `copilot/gpt-4o`) → **Copilot** (prefix stripped)
2. a bare id that exists only in the Copilot catalog → **Copilot**
3. everything else → **Kiro**

Cross-protocol calls are translated automatically (Anthropic↔OpenAI), so a
Copilot model works through `/v1/messages` and a Kiro model works through
`/v1/chat/completions`.

## Monitoring

Open **http://localhost:9000/dashboard** for a live view (auto-refreshes every
4s) of per-model request counts, errors, and input/output token totals, plus
which providers are authenticated. Stats are in-memory and reset on restart.

## Use with Claude Code

```bash
ANTHROPIC_BASE_URL=http://localhost:9000 ANTHROPIC_AUTH_TOKEN=any-value claude
```

Then run `/models` inside Claude Code to switch between every model from both
providers.

## Credits

Original work, inspired by the designs of
[jwadow/kiro-gateway](https://github.com/jwadow/kiro-gateway) (AGPL-3.0) and
[caozhiyuan/copilot-api](https://github.com/caozhiyuan/copilot-api) (MIT). No
code from either project is included here.

## License

MIT
