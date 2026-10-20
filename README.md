# unified-ai-gateway

A single **Anthropic/OpenAI-compatible** gateway that merges the model catalogs of
two upstreams behind one endpoint:

- [**kiro-gateway**](https://github.com/jwadow/kiro-gateway) — Claude models via Kiro / Amazon Q
- [**copilot-api**](https://github.com/caozhiyuan/copilot-api) — GitHub Copilot, Codex and third-party models

Point Claude Code (or any Anthropic/OpenAI client) at this one server and you get
the union of both providers' models in a single `/v1/models` list, with requests
automatically routed to whichever backend owns the chosen model.

```
                       ┌─────────────────────┐
  Claude Code  ─────▶  │ unified-ai-gateway  │  :9000
  (or any client)      │   /v1/models        │
                       │   /v1/messages       │
                       │   /v1/chat/...       │
                       └────────┬─────┬───────┘
                        model=  │     │  =copilot/<id> or known copilot id
                        kiro id │     │
                                ▼     ▼
                   kiro-gateway:8000  copilot-api:4141
```

## Why

`kiro-gateway` and `copilot-api` are both Anthropic-compatible, but they are
separate servers on separate ports with separate model lists. Switching between
them means reconfiguring your client each time. This gateway federates them:

- **One endpoint** for every model from both providers.
- **No collisions** — copilot models are namespaced with a configurable prefix
  (`copilot/` by default), so `copilot/claude-sonnet-5` and the kiro
  `claude-sonnet-5` can coexist.
- **Transparent routing** — the `model` field in each request decides the backend.
- **Graceful degradation** — if one upstream is down, the other's models are
  still listed and usable.

## Requirements

- Node.js >= 20
- A running `kiro-gateway` (default `http://localhost:8000`) and/or
  `copilot-api` (default `http://localhost:4141`). You can run just one; the
  gateway serves whatever is reachable.

## Setup

```bash
npm install
cp .env.example .env   # edit if your ports/keys differ
npm run start          # dev run via tsx
# or:
npm run build && npm run serve   # compiled JS
```

## Configuration

All configuration is via environment variables (or a `.env` file). Defaults:

| Variable             | Default                  | Description                                            |
| -------------------- | ------------------------ | ------------------------------------------------------ |
| `PORT`               | `9000`                   | Port this gateway listens on.                          |
| `KIRO_GATEWAY_URL`   | `http://localhost:8000`  | Base URL of kiro-gateway.                              |
| `KIRO_GATEWAY_KEY`   | *(empty)*                | Bearer key for kiro-gateway, if it requires one.       |
| `COPILOT_API_URL`    | `http://localhost:4141`  | Base URL of copilot-api.                               |
| `COPILOT_API_KEY`    | *(empty)*                | Bearer key for copilot-api, if it requires one.        |
| `COPILOT_PREFIX`     | `copilot/`               | Namespace applied to copilot model ids.                |
| `REQUEST_TIMEOUT_MS` | `600000`                 | Per-request upstream timeout (ms).                     |

## Endpoints

| Method | Path                   | Description                                                      |
| ------ | ---------------------- | ---------------------------------------------------------------- |
| `GET`  | `/health`              | Reports reachability of both upstreams.                          |
| `GET`  | `/v1/models`           | Merged catalog. Kiro ids as-is; copilot ids prefixed.            |
| `POST` | `/v1/messages`         | Anthropic Messages API. Routed by `model`. Streaming supported.  |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions API. Routed by `model`. Streaming too.   |

### Routing rules

For a request's `model`:

1. starts with `COPILOT_PREFIX` (e.g. `copilot/gpt-5`) → **copilot-api** (prefix stripped)
2. a bare id that exists only in the copilot catalog → **copilot-api**
3. everything else → **kiro-gateway**

`/v1/models` must be hit at least once for rule 2 to know the copilot catalog;
rule 1 (the explicit prefix) always works regardless.

## Examples

List every model from both providers:

```bash
curl -s http://localhost:9000/v1/models | jq -r '.data[] | "\(.owned_by)\t\(.id)"'
```

Call a kiro model:

```bash
curl -s http://localhost:9000/v1/messages \
  -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-sonnet-5","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'
```

Call a copilot model (explicit prefix):

```bash
curl -s http://localhost:9000/v1/messages \
  -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"copilot/claude-sonnet-5","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'
```

## Use with Claude Code

Point Claude Code at this gateway and the `/models` picker shows every model from
both providers:

```bash
ANTHROPIC_BASE_URL=http://localhost:9000 \
ANTHROPIC_AUTH_TOKEN=any-value \
claude
```

Then run `/models` inside Claude Code to switch between them live.

## License

MIT
