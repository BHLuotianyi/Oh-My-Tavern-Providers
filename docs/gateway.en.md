English | [简体中文](./gateway.md) | [Back to README](../README.en.md)

# Server plugin reference

The server plugin (`server-plugin/` in this repository, installed to `SillyTavern/plugins/omtp/`) runs inside the SillyTavern process and provides two things:

- **Management API**: mounted under SillyTavern's `/api/plugins/omtp/*`; the OMTP client uses it to read and write configuration, keys and sign-in state.
- **Gateway**: a separate OpenAI-compatible HTTP server at `http://127.0.0.1:4100/v1` by default. SillyTavern connects to it as a Custom OpenAI source; the gateway picks a protocol adapter from the catalog and forwards the request upstream.

Plugin data lives in `<SillyTavern data directory>/omtp/`, which is `SillyTavern/data/omtp/` by default.

## Contents

- [Gateway](#gateway)
- [Management API](#management-api)
- [Protocol adapters](#protocol-adapters)
- [Credentials](#credentials)
- [OAuth sign-in](#oauth-sign-in)
- [Request identity headers](#request-identity-headers)
- [Quotas](#quotas)
- [Usage statistics and cost](#usage-statistics-and-cost)
- [Live model cache](#live-model-cache)
- [Outbound proxy](#outbound-proxy)
- [Data files](#data-files)
- [Environment variables](#environment-variables)
- [Security boundaries](#security-boundaries)
- [Companion (TauriTavern)](#companion-tauritavern)

## Gateway

- **Address**: bound to `127.0.0.1` only. Port 4100 by default, configurable in the settings.
- **Port conflicts**: if the port is taken, 4101 … 4110 are tried in turn and the port that works is saved to the config. If the port is held by another OMTP gateway that accepts this instance's token (or both have authentication off), that gateway is reused; one that rejects the token is skipped.
- **Authentication**: `Authorization: Bearer <token>` is required by default and compared in constant time. The token is generated on first start, stored in `gateway-token` (`0600`), and handed to the client by `GET /api/plugins/omtp/gateway/token`.
- **Authentication off**: with `requireAuth: false` no token is checked, but `/v1/*` only accepts requests whose Host is `localhost`, `127.x` or `::1`; anything else gets 403 `host_not_allowed`.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | none | Returns `{ ok, service: 'omtp-gateway', version, catalogVersion }` |
| `GET` | `/v1/models` | token | `provider/model` ids that have usable credentials (or need none) |
| `POST` | `/v1/chat/completions` | token | OpenAI-compatible chat completions, streaming SSE or JSON |

The `model` of `/v1/chat/completions` must be `provider/model`. The `X-OMTP-Chat` header (the chat id, percent-encoded by SillyTavern) attributes usage to a chat. When the client disconnects, the gateway aborts the upstream request; usage produced so far is still recorded.

## Management API

All routes live under `/api/plugins/omtp`, use SillyTavern's own session and CSRF checks, and additionally require the header `x-omtp-client: omtp-web` (see [Security boundaries](#security-boundaries)).

| Area | Route | Description |
|---|---|---|
| Status | `GET /status` | Plugin version, gateway state and port, catalog statistics |
| Gateway | `GET /gateway/token` | Read the gateway token |
| | `POST /gateway/restart` | Restart the gateway |
| | `GET /config`, `POST /config` | Read or change `autoStart`, `port`, `requireAuth`. Setting `requireAuth` to `false` also requires `confirmInsecure: true` |
| Catalog | `GET /catalog` | The merged catalog |
| | `POST /catalog/refresh` | Refresh the catalog from the body's `url` (or the default upstream) |
| | `POST /import/omp` | Import a catalog overlay from a local OMP; with `credentials: true` and `confirm: true` also import credentials |
| Providers | `GET /providers` | Availability, credential source, last four key characters, sign-in method and model count per provider |
| | `POST /providers/:id/key`, `DELETE /providers/:id/key` | Save or clear an API key |
| | `POST /providers/:id/config`, `DELETE /providers/:id/config` | Create, change or delete provider config (`label`, `adapter`, `baseUrl`, `headers`, `extraConfig`, `custom`, `models`, `userAgentSpoof`) |
| | `POST /providers/:id/test` | Call the provider through its real adapter to check connectivity |
| | `GET /providers/:id/models` | Live model list; `?refresh=true` skips the cache. See [Live model cache](#live-model-cache) |
| Sign-in | `POST /providers/:id/login` | Start a sign-in session |
| | `GET /providers/:id/login/:session` | Session state: `pending`, `done`, `error` |
| | `POST /providers/:id/login/:session/code` | Submit a pasted callback URL or authorization code |
| | `DELETE /providers/:id/login/:session` | Cancel a session |
| | `POST /providers/:id/logout` | Sign out and clear credentials |
| Usage | `GET /usage` | Quotas of subscription providers; `?refresh=true` skips the cache |
| | `GET /stats` | Token and cost statistics; `?chat=` per chat, `?since=` from a point in time |
| | `GET /stats/server`, `GET /stats/server/status` | Start (or reuse) the statistics page, or query its state |

When `providers.json` or `master.key` cannot be decrypted, the affected routes answer 409 and never overwrite the existing data.

## Protocol adapters

| Adapter | Upstream protocol | Notes |
|---|---|---|
| `openai` | OpenAI Chat Completions | Passed through, keeping streaming SSE, tool calls and `reasoning_content` |
| `anthropic` | Anthropic Messages | Converts system prompts, tool definitions and thinking blocks; supports Claude subscription OAuth |
| `google` | Gemini API | Keeps cache-hit and thinking token counts |
| `google-vertex` | Vertex AI | Service-account JSON or ADC tokens, regional endpoints |
| `antigravity` | Cloud Code Assist (`v1internal`) | Google Antigravity and Gemini CLI OAuth sessions, failover across endpoints |
| `responses` | OpenAI Responses API | Converts Chat Completions to `/responses`, keeping reasoning and cache counts |
| `azure-responses` | Azure OpenAI Responses | Azure deployment paths, `api-key` header, `api-version` |
| `bedrock` | Amazon Bedrock Converse | AWS signing or bearer token; Converse responses are turned into OpenAI SSE |
| `ollama` | Ollama | Local `/api/chat` and `/v1` endpoints, no key needed |

Providers that only speak a proprietary client protocol or have no public headless sign-in, and search services that are not chat models, cannot be forwarded. They stay listed in the panel with the reason (catalog field `unsupportedReason`).

## Credentials

A provider's credentials are taken from the first of these that has a value:

1. The OMTP key store `providers.json` (AES-256-GCM, master key `master.key`)
2. The default SillyTavern user's `secrets.json` (such as `api_key_openai`, `api_key_claude`)
3. The environment variables the catalog declares for the provider (such as `OPENAI_API_KEY`)

Some sign-in flows store several providers' credentials in one record (catalog field `authLogin.storeAs`).

## OAuth sign-in

Each provider's `authLogin` in the catalog describes how it signs in:

| Kind | Flow |
|---|---|
| `oauth-code` | Authorization code, optionally with PKCE. The plugin listens for the callback on a loopback address; the callback URL can also be pasted |
| `device-code` | RFC 8628 device code; the plugin polls in the background |
| `custom` | Provider-specific flow; `openai-codex-device` and `kilo` are implemented |

The callback listener follows `authLogin.callback`:

| Field | Behavior |
|---|---|
| `redirectUri` | The declared value wins. An `http://` loopback URI is served on its host, port and path; custom schemes such as `zcode://` or `vscode://` cannot be received locally, so the flow switches to pasting |
| `manualOnly` | No listener; only the authorization link and paste instructions are returned |
| `nativeScheme` | Same as `manualOnly` (the plugin has no OS protocol handler) |
| `portFallback` | If the port is taken, the flow switches to pasting and explains why in `instructions` |

A `localhost` callback listens on both `127.0.0.1` and `::1`. A callback must carry the session's `state` (except for providers declaring `state: none`, such as OpenRouter); one without it or with a different value gets a 400 and leaves the session and its port alone. Duplicate callbacks for one code share a single exchange. Requests without a `code` (probes from proxies or security software) do not end the session.

After the code exchange, the hook named in `authLogin.afterExchange` may complete the credential:

| Hook | Purpose |
|---|---|
| `anthropic-identity` | Account and organization details |
| `openai-codex-profile` | Codex account details |
| `google-gemini-cli-project`, `google-antigravity-project` | Look up the Google Cloud project id |
| `zai-mint-key` | Trade the short-lived token for a long-lived API key |
| `muse-code-key` | Obtain an API key |
| `factory-droid-region` | Determine the regional endpoint |
| `gitlab-duo-clear-cache` | Clear the stale direct-access cache |

An unknown hook is logged and does not affect the sign-in result.

### OAuth client credentials

An installed app's `client_id` / `client_secret` are public identifiers (RFC 8252 §8.1), so the catalog ships them by default and subscription sign-in works out of the box. The one exception is `google-gemini-cli`: its endpoints only accept the first-party app, so the catalog keeps just the environment-variable names and the values must be configured locally (see `LOCAL_ONLY_CLIENTS` in `server-plugin/lib/catalog-normalize.mjs`). Any provider's values can be overridden locally:

- environment variables `OMTP_<PROVIDER>_CLIENT_ID` and `OMTP_<PROVIDER>_CLIENT_SECRET`, where the provider id is upper-cased and non-alphanumerics become `_`, e.g. `OMTP_GOOGLE_ANTIGRAVITY_CLIENT_ID`;
- or `oauth-clients.json`:

  ```json
  {
    "google-antigravity": { "clientId": "…", "clientSecret": "…" },
    "openai-codex": { "clientId": "…" }
  }
  ```

Environment variables take precedence. User tokens are only ever stored in the encrypted key store.

## Request identity headers

Some upstreams want a session identifier and a client identity. A provider's `requestHeaders` in the catalog declares the policy; the gateway fills it in:

| Field | Purpose |
|---|---|
| `sessionHeader`, `sessionPrefix` | Name and prefix of the session header. The value is a 24-character base62 string derived as `HMAC-SHA256(install-id, provider + chat id)`: stable per chat and provider, stable across restarts, and it does not reveal the chat file name |
| `sessionForce` | When true, the session header replaces a header of the same name from the user's config |
| `spoofUserAgent` | Value used by the sign-in panel's User-Agent switch, on by default; when off, SillyTavern's own User-Agent is forwarded |

Requests without a chat (quota polls, model discovery) use the `install-id` itself. Providers that currently declare the policy: `opencode-go` and `opencode-zen` (`x-opencode-session`).

## Quotas

`GET /usage` calls the quota endpoint of every provider that has credentials; results are cached per credential for 60 seconds:

| Provider | Upstream endpoint | Returns |
|---|---|---|
| Google Antigravity, Gemini CLI | `POST /v1internal:retrieveUserQuotaSummary` | Weekly and 5-hour windows per model family |
| OpenAI Codex | `GET chatgpt.com/backend-api/wham/usage` | Primary and secondary windows, plan name |
| Anthropic (Claude Pro / Max) | `GET api.anthropic.com/api/oauth/usage` | 5-hour and 7-day windows, extra-usage balance |
| Z.AI, Zhipu Coding Plan | `GET api.z.ai/api/monitor/usage/quota/limit` | Token, time and quota windows |
| Kimi Code | `GET api.kimi.com/coding/v1/usages` | Windows per period |
| MiniMax (international / China) | `GET {api.minimax.io, api.minimaxi.com}/v1/token_plan/remains` | 5-hour and weekly remaining per model |
| xAI | `GET cli-chat-proxy.grok.com/v1/billing?format=credits` | Weekly credits, monthly included quota, on-demand billing |
| GitHub Copilot | `GET api.github.com/copilot_internal/user` | Premium, Chat and Completions quotas with reset times |
| OpenCode Go | `GET opencode.ai/zen/go/v1/usage` | 5-hour, weekly and monthly windows |
| Cursor | `GET api2.cursor.sh/auth/usage` | Requests in the billing period |
| Command Code | `GET api.commandcode.ai/alpha/billing/credits` | 5-hour and weekly windows, credits |
| ClinePass | `GET api.cline.bot/api/v1/users/me/plan/usage-limits` | 5-hour, weekly and monthly windows |
| Synthetic | `GET api.synthetic.new/v2/quotas` | 5-hour and weekly windows |
| Umans | `GET api.code.umans.ai/v1/usage` | Request window and burst limit |
| Charm Hyper | `GET hyper.charm.land/v1/credits` | Credit balance |
| DeepSeek | `GET api.deepseek.com/user/balance` | Balance per currency |

`ADAPTERS` in `server-plugin/lib/usage.mjs` is the authoritative list.

## Usage statistics and cost

The gateway reads the last `usage` object of every response (streaming or not) and accumulates it per provider, model, day and chat in `usage-stats.json`. Tokens fall into non-overlapping buckets:

| Bucket | Source |
|---|---|
| Input | `prompt_tokens` minus the cache read and write parts |
| Cache read, cache write | `prompt_tokens_details` or the protocol's equivalent fields |
| Output | `completion_tokens`, **including** reasoning tokens |
| Reasoning | `completion_tokens_details.reasoning_tokens`, a part of output |

Every adapter reports `usage` this way. Gemini's `candidatesTokenCount`, for example, excludes thinking, so the adapter adds `thoughtsTokenCount` to `completion_tokens`.

Cost is estimated from the catalog's per-million-token prices:

```
input × input price
+ cache read × cache read price + cache write × cache write price
+ (output − reasoning) × output price
+ reasoning × reasoning price
```

When a price is 0 or missing, cache reads and writes use the input price and reasoning uses the output price. Models discovered live without a catalog price use the provider's default model price, or else the median output price of its priced models.

The statistics page opened by `/omtp stats` is started by `GET /stats/server`. It listens on `127.0.0.1` only, on port 3847 by default (another port if that one is taken), and shuts down after 30 minutes without requests.

## Live model cache

`GET /providers/:id/models` calls the provider's model listing (the adapter's `listModels` when it has one, otherwise the provider's `/models`).

- **Freshness**: successful results younger than 5 minutes (`LIVE_MODELS_TTL`) are returned without calling upstream.
- **No fallback**: past the freshness window, or with `?refresh=true`, upstream is always called; a failure returns `ok: false` with the error, never the old list.
- **Invalidation**: saving or deleting a key, changing or deleting provider config, signing out, completing a sign-in and importing OMP credentials remove the provider's entry. A probe that spans one of these changes is not cached and returns `ok: false`.
- **Persistence**: successful results are written to `live-models.json` (`0600`, model ids and metadata only); entries still inside the freshness window are loaded on start. At most 128 providers are kept.
- **Client**: `src/catalog.js` ages a list from the server's probe time `at`; after a failed probe or a credential change it drops the provider's list and falls back to the bundled catalog models.

## Outbound proxy

Node's built-in `fetch` ignores proxy environment variables. On start the plugin replaces the global `fetch` with a proxy-aware implementation (`lib/proxy-fetch.mjs`) used by sign-in, key checks, quota queries and gateway forwarding.

| Variable | Effect |
|---|---|
| `HTTPS_PROXY` / `https_proxy` | HTTPS targets, through an HTTP `CONNECT` or SOCKS5 tunnel |
| `HTTP_PROXY` / `http_proxy` | HTTP targets |
| `ALL_PROXY` / `all_proxy` | Fallback proxy; `http://`, `https://` and `socks5://` (also `socks5h://`, `socks://`); SOCKS4 is ignored |
| `NO_PROXY` / `no_proxy` | Direct-connect list: `*`, `*.example.com`, `.example.com`, `host:port` and IPv6 literals |
| `OMTP_DISABLE_PROXY=1` | Disables the implementation entirely |

Without a usable proxy variable the plugin reads the operating system's proxy settings: the Windows registry, `scutil --proxy` on macOS, GNOME's `gsettings` on Linux. The result is cached for 10 seconds, so turning on Clash's system proxy after SillyTavern started takes effect. With neither, requests connect directly. On Node 24 and later with `NODE_USE_ENV_PROXY=1`, Node handles the proxy itself and the plugin leaves `fetch` alone.

- Loopback and private ranges (`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`) always connect directly.
- If the tunnel cannot be opened, the request falls back to a direct connection and the failure is logged once; when the direct connection fails too, the error also carries the proxy's failure. A failure after request bytes reached the tunnel, or after the origin answered, is never retried, so a completion is not billed twice.
- Redirects followed through the tunnel drop `Authorization`, `Cookie`, `Proxy-Authorization`, `x-api-key`, `api-key` and `x-goog-api-key` when they leave the origin.

Sign-in callbacks are received by a separate loopback listener and never pass through the proxy. A browser proxy that does not bypass loopback (no `--proxy-bypass-list="<-loopback>"`, Proxifier, some security software web shields), a container without the callback port published, or a browser on another machine keeps the callback from arriving; the panel then asks for the address-bar URL to be pasted.

## Data files

All in `<SillyTavern data directory>/omtp/`, directory mode `0700`.

| File | Format | Contents |
|---|---|---|
| `config.json` | JSON | `autoStart`, `port`, `requireAuth` |
| `gateway-token` | text, `0600` | Gateway token (not encrypted) |
| `master.key` | hex, `0600` | AES-256-GCM master key for `providers.json` |
| `providers.json` | JSON, `0600` | Encrypted keys, OAuth tokens and provider config, each entry `enc:v1:…` |
| `install-id` | text, `0600` | Installation id (UUID v4) used to derive session headers |
| `oauth-clients.json` | JSON, `0600`, optional | Local OAuth client credentials |
| `kimi-device-id` | text | Device id for Kimi sign-in |
| `usage-stats.json` | JSON, `0600` | Usage statistics |
| `live-models.json` | JSON, `0600`, optional | Live model cache |
| `catalog.json` | JSON, optional | Catalog layer from an online refresh |
| `imported-catalog.json` | JSON, optional | Catalog layer imported from a local OMP |

Back up `master.key` together with `providers.json`: without the master key, encrypted credentials cannot be recovered.

## Environment variables

| Variable | Effect |
|---|---|
| `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY` | Outbound proxy, see [Outbound proxy](#outbound-proxy) |
| `OMTP_DISABLE_PROXY=1` | Disable proxy support |
| `OMTP_STRICT_HOST=1` | The management API only accepts allow-listed Host headers |
| `OMTP_ALLOWED_HOSTS` | Comma-separated hosts added to that allow list |
| `OMTP_OMP_CATALOG_ROOTS` | Extra OMP directories allowed for import, separated by the system path delimiter |
| `OMTP_<PROVIDER>_CLIENT_ID`, `OMTP_<PROVIDER>_CLIENT_SECRET` | Override OAuth client credentials |
| `PI_AI_CLAUDE_CODE_VERSION`, `PI_AI_GEMINI_CLI_VERSION`, `PI_AI_ANTIGRAVITY_VERSION`, `PI_AI_ANTIGRAVITY_CL` | Override the client versions reported to providers (defaults in `lib/client-versions.mjs`). Raise the Claude Code version temporarily when Anthropic rejects it as too old |
| Key variables declared by the catalog (such as `OPENAI_API_KEY`) | Third credential source |

## Security boundaries

- **Management API**: requires the `x-omtp-client: omtp-web` header. A browser must send a CORS preflight before a custom header, and SillyTavern does not allow the preflight, so cross-site pages cannot call these routes. `Origin` must match `Host`, and `Sec-Fetch-Site` must not be `cross-site`. Failures get 403 `untrusted_client`. See the [developer API](./developer.en.md#calling-the-plugin-api-from-scripts) for scripted access.
- **Host allow list**: with `OMTP_STRICT_HOST=1`, the management API only accepts `localhost`, `127.0.0.1`, `::1` and the hosts in `OMTP_ALLOWED_HOSTS`, which defends against DNS rebinding. Reverse-proxy setups with a public host name must add that name, which is why it is off by default.
- **Gateway**: listens on `127.0.0.1` only and requires a token by default. Turning authentication off must be confirmed explicitly through the API, and afterwards only loopback Host headers are accepted.
- **Credentials**: the management API returns credential sources, last four characters or masked e-mail addresses, never plaintext. An invalid `master.key` is backed up as `master.key.corrupt-<timestamp>` and reported instead of being regenerated; a missing `master.key` while `providers.json` holds ciphertext is reported as well.
- **Catalog**: catalog layers from online refreshes and OMP imports may only change model lists, names, prices and similar data. `baseUrl`, `gatewayAdapter`, `authLogin` and request headers always come from the bundled catalog, so a tampered catalog cannot send keys to another server. A new provider may only point at hosts the bundled catalog already uses or at loopback. Refreshes reject cross-host redirects.
- **OMP import**: only `~/oh-my-pi`, `~/.omp` and directories in `OMTP_OMP_CATALOG_ROOTS` can be read.
- **Custom base URLs**: only http(s) URLs without a query string or embedded credentials are accepted, checked when saved and again when used; an invalid stored value falls back to the bundled endpoint.
- **OAuth callbacks**: see [OAuth sign-in](#oauth-sign-in).
- **Companion**: see the next section.

## Companion (TauriTavern)

`node server-plugin/standalone.mjs` runs the same management API and gateway outside SillyTavern, for TauriTavern, which cannot load server plugins. `index.mjs` (SillyTavern) and `standalone.mjs` are both entries to `lib/plugin.mjs`: the former supplies SillyTavern's Express and secret reader, the latter `lib/mini-express.mjs` and a token check.

| Option | Default | Meaning |
|---|---|---|
| `--data DIR` | `~/.omtp-companion` | Data directory; state goes to `DIR/omtp/`. Point it at `SillyTavern/data` to share keys with SillyTavern |
| `--host ADDR` | `127.0.0.1` | Address the companion and the gateway bind to; `0.0.0.0` for other devices on the LAN |
| `--port N` | `4099` | Companion port; the gateway keeps its own port (4100 by default) |

- **Management API**: served at `http://<host>:<port>/api/plugins/omtp` with the same routes as the plugin. Requests come from the TauriTavern WebView on another origin, so the `Origin` check does not apply; `x-omtp-client: omtp-web` and `x-omtp-token: <token>` are required instead. The token is generated on first start, stored in `companion-token` (`0600`) and printed at startup. CORS preflights echo the requested `Origin` and headers.
- **`GET /health`**: no token needed; returns `{ok:true, service:'omtp-companion'}`.
- **SillyTavern secrets**: the companion cannot read SillyTavern's or TauriTavern's `secrets.json`; credentials come only from OMTP's own key store and environment variables.
- **Gateway**: as in the plugin; `--host` also sets the gateway's bind address. The client replaces the `127.0.0.1` the companion reports with the companion's host name before writing `custom_url`. TauriTavern asks the user to authorize that address the first time it connects.
- **Statistics page**: still listens on `127.0.0.1` only.
