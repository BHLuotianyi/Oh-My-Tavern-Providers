[English](./gateway.en.md) | [简体中文](./gateway.md) | [Back to README](../README.en.md)

# Gateway & Server Plugin Reference

This document covers the HTTP routes, protocol adapters, quota endpoints, and on-disk data formats of the optional OMTP server plugin (`server-plugin/`). For standard installation and daily usage, see the [main README](../README.en.md#getting-started).

---

## 1. Listener & Authentication

- **Default URL**: `http://127.0.0.1:4100/v1` (bound strictly to loopback `127.0.0.1`).
- **Port fallback**: Scans `4100–4110` if `4100` is in use, or reuses an existing `omtp-gateway` listener. The client queries `/api/plugins/omtp/status` to discover the active port automatically.
- **Authentication**: Bearer token verification enabled by default (constant-time `crypto.timingSafeEqual`). Generated on first boot and stored as plaintext hex at `data/omtp/gateway-token` with file mode `0600` (not encrypted; readable via `GET /api/plugins/omtp/gateway/token` by the local SillyTavern frontend).

### Standalone Gateway Routes (`127.0.0.1:4100`)

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | None | Liveness probe returning `{ ok, service: 'omtp-gateway', version, catalogVersion }` |
| `GET` | `/v1/models` | Bearer (default) | Lists `provider/model` entries with valid credentials or keyless access |
| `POST` | `/v1/chat/completions` | Bearer (default) | OpenAI-compatible chat completions (streaming SSE & non-streaming JSON); attributes usage via `X-OMTP-Chat` |

---

## 2. SillyTavern Plugin Routes (`/api/plugins/omtp`)

Mounted on SillyTavern's Express app under `/api/plugins/omtp` (**24 routes** total):

| Group | Method & Path | Description |
|---|---|---|
| **Status & Gateway** | `GET /status` | Plugin version, gateway status/port, and catalog counters |
| | `GET /gateway/token` | Returns the local gateway Bearer token |
| | `POST /gateway/restart` | Restarts the gateway listener |
| | `GET /config` · `POST /config` | Reads or updates `autoStart`, `port`, `requireAuth` |
| **Catalog & Import** | `GET /catalog` | Returns the merged catalog (OAuth client fields normalized by policy: public client pairs kept, the rest scrubbed to env references) |
| | `POST /catalog/refresh` | Fetches and validates a catalog update from a URL or upstream |
| | `POST /import/omp` | Imports a catalog overlay and optional `agent.db` credentials from a local `oh-my-pi` checkout |
| **Providers & Keys** | `GET /providers` | Lists provider availability, key source, `last4` fingerprint, login flows, and model counts |
| | `POST /providers/:id/key` · `DELETE /providers/:id/key` | Encrypts and stores or clears a provider API key |
| | `POST /providers/:id/config` · `DELETE /providers/:id/config` | Saves or deletes custom provider config (`label/adapter/baseUrl/headers/extraConfig/models`) |
| | `POST /providers/:id/test` | Probes upstream connectivity using the provider's adapter |
| | `GET /providers/:id/models` | Probes live upstream `/models` (supports `?refresh=true`) |
| **OAuth & Sign-in** | `POST /providers/:id/login` | Starts an `oauth-code`, `device-code`, or `custom` login flow |
| | `GET /providers/:id/login/:session` | Polls login session status (`pending` / `done` / `error`) |
| | `POST /providers/:id/login/:session/code` | Submits a pasted callback URL or authorization code for `oauth-code` flows |
| | `DELETE /providers/:id/login/:session` | Cancels an active login session |
| | `POST /providers/:id/logout` | Clears stored credentials for the provider |
| **Usage & Stats** | `GET /usage` | Queries provider quota windows and balances (60s cache, `?refresh=true` to force) |
| | `GET /stats` | Returns token and cost totals (all-time, `?chat=<id>`, or `?since=<ISO>`) |
| | `GET /stats/server` · `GET /stats/server/status` | Starts (or reuses) the local stats dashboard server (default port `3847`) or checks its status |

**Login callback policy** (from `authLogin.callback` in the catalog):

| Field | Behavior |
|---|---|
| `redirectUri` | Declared value wins: an `http://` loopback URI is bound on its own host/port/path; custom schemes (`zcode://`, `vscode://`) cannot be received here, so the flow switches to manual paste |
| `manualOnly` | No local listener; returns the authorize link plus paste instructions |
| `nativeScheme` | Same as above (this plugin has no OS protocol handler) |
| `portFallback` | When the port is taken the flow no longer returns a dead `redirect_uri`; it degrades to manual paste and explains why in `instructions` |

**After-exchange hooks** (`authLogin.afterExchange`): `zai-mint-key` (short-lived OAuth token → durable API key), `anthropic-identity` (account/organization), `openai-codex-profile`, `google-gemini-cli-project` / `google-antigravity-project` (project id), `muse-code-key`, `factory-droid-region`, `gitlab-duo-clear-cache`. An unknown hook is logged and ignored; it never blocks the sign-in.

---

## 3. Protocol Adapters (9 Adapters)

| Adapter ID | Upstream Protocol | Highlights |
|---|---|---|
| `openai` | OpenAI Chat Completions | Standard passthrough for SSE streaming, tool calls, and `reasoning_content` |
| `anthropic` | Anthropic Messages | System prompt extraction, tool schema conversion, thinking blocks, Claude Code OAuth headers |
| `google` | Google Generative AI | Native Gemini contents, preserving `cachedContentTokenCount` and `thoughtsTokenCount` |
| `google-vertex` | Google Cloud Vertex AI | Service account / ADC token exchange and regional Vertex endpoints |
| `antigravity` | Cloud Code Assist (`v1internal`) | Supports Google Antigravity and Gemini CLI OAuth sessions with endpoint failover |
| `responses` | OpenAI Responses API | Translates Chat Completions to `/responses` with reasoning and cached token accounting |
| `azure-responses` | Azure OpenAI Responses | Azure deployment routing, `api-key` header, and `api-version` handling |
| `bedrock` | Amazon Bedrock Converse | AWS SigV4 or Bearer auth; synthesizes OpenAI SSE chunks from Converse responses |
| `ollama` | Ollama Chat | Local Ollama `/api/chat` and `/v1` support (keyless) |

> **Unsupported providers**: Providers requiring proprietary client/agent protocols (`apple`, `cursor`, `devin`, `github-copilot`, `gitlab-duo`, `gitlab-duo-agent`, `stencil`, `xai-oauth`) or non-chat search APIs (`exa`, `kagi`, `parallel`, `perplexity`, `tavily`, `typesafe`, `web`) remain visible in the hub with an explicit unavailable reason.

---

## 4. Quota Endpoints (`USAGE_PROVIDERS`)

| Provider | Upstream Endpoint | Reported Data |
|---|---|---|
| Google Antigravity / Gemini CLI | `POST /v1internal:retrieveUserQuotaSummary` | Weekly / 5-hour windows per model family |
| OpenAI Codex / ChatGPT plans | `GET chatgpt.com/backend-api/wham/usage` | Primary & secondary windows + plan tier |
| Anthropic Claude Pro / Max | `GET api.anthropic.com/api/oauth/usage` | 5-hour / 7-day windows + extra-usage balance |
| Z.AI / Zhipu Coding Plans | `GET api.z.ai/api/monitor/usage/quota/limit` | Token / time / credit windows (raw token auth) |
| Kimi Code | `GET api.kimi.com/coding/v1/usages` | Used and remaining percentages per window |
| MiniMax Token Plan (intl / CN) | `GET {api.minimax.io\|api.minimaxi.com}/v1/token_plan/remains` | 5-hour / weekly buckets per model |
| xAI (SuperGrok) | `GET cli-chat-proxy.grok.com/v1/billing?format=credits` | Weekly credits, monthly included quota, on-demand |
| GitHub Copilot | `GET api.github.com/copilot_internal/user` | Premium / chat / completions quota snapshots |
| OpenCode Go | `GET opencode.ai/zen/go/v1/usage` | 5-hour / weekly / monthly rolling windows |
| Cursor | `GET api2.cursor.sh/auth/usage` | Billing-cycle request quota |
| Command Code | `GET api.commandcode.ai/alpha/billing/credits` | 5-hour / weekly windows + credit balance |
| ClinePass | `GET api.cline.bot/api/v1/users/me/plan/usage-limits` | 5-hour / weekly / monthly windows |
| Synthetic | `GET api.synthetic.new/v2/quotas` | Rolling 5-hour / weekly windows |
| Umans | `GET api.code.umans.ai/v1/usage` | Request window and burst ceiling |
| Charm Hyper | `GET hyper.charm.land/v1/credits` | Account credit balance |
| DeepSeek | `GET api.deepseek.com/user/balance` | Prepaid balance per currency |

---

## 5. Data Files & Key Resolution (`$DATA_ROOT/omtp/`)

| File | Mode / Encryption | Contents |
|---|---|---|
| `config.json` | JSON | `autoStart`, `port`, `requireAuth` |
| `gateway-token` | `0600` plaintext hex | Local gateway Bearer token (not encrypted) |
| `master.key` | `0600` 32-byte hex | AES-256-GCM master key for `providers.json` |
| `providers.json` | `0600` AES-256-GCM | Encrypted provider API keys, OAuth tokens, and custom provider configs (`enc:v1:...`) |
| `oauth-clients.json` | `0600` JSON (optional) | User-supplied OAuth `clientId` / `clientSecret` pairs |
| `kimi-device-id` | Text | Stable device ID used by the `kimi-fingerprint` login hook |
| `usage-stats.json` | JSON | Token and estimated cost ledger per chat, per model, and per day |
| `catalog.json` | JSON (optional) | Cached online catalog refresh |
| `imported-catalog.json` | JSON (optional) | Overlay generated by local `oh-my-pi` import |

**Key Resolution Order**:
1. **OMTP KeyStore** (`data/omtp/providers.json`)
2. **SillyTavern Secrets** (default user's `secrets.json`, e.g., `api_key_openai`, `api_key_claude`)
3. **Environment Variables** (provider `env` names declared in the catalog, e.g., `OPENAI_API_KEY`)

---

## 6. Outbound Proxy

Node's built-in `fetch` ignores proxy environment variables, so the server plugin replaces `globalThis.fetch` at startup with a proxy-aware implementation (`lib/proxy-fetch.mjs`). It covers sign-in, key probes, quota lookups and gateway forwarding:

| Variable | Effect |
|---|---|
| `HTTPS_PROXY` / `https_proxy` | HTTPS targets (HTTP `CONNECT` tunnel) |
| `HTTP_PROXY` / `http_proxy` | HTTP targets |
| `ALL_PROXY` / `all_proxy` | Fallback proxy (`http://` / `https://` only; SOCKS is ignored) |
| `NO_PROXY` / `no_proxy` | Direct-connect list: `*`, `*.example.com`, `.example.com`, `host:port`, IPv6 literals |
| `OMTP_DISABLE_PROXY=1` | Disables the wrapper entirely |

Loopback and private ranges (`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`) always connect directly. A failed tunnel falls back to a direct connection; a failure after request bytes reached the tunnel is not replayed, so a completion is never billed twice.
