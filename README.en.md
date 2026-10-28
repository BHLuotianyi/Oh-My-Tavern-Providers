# OMTP Model Hub (Oh-My-Tavern-Providers)

A model-selection extension for SillyTavern 1.12.7+. It puts SillyTavern's native models, the other providers in the OMP catalog, and an optional local OpenAI-compatible gateway behind one searchable panel. Selections go through SillyTavern's own path whenever possible; only models that path cannot address use the gateway.

[简体中文](README.md)

OMTP does not install, start, or invoke OMP. OMP (oh-my-pi) is only a source of catalog data and design reference. Both the client extension and the optional server plugin are implemented independently for SillyTavern.

## Routing

Each catalog entry is routed in this order:

1. The native control on the current SillyTavern page accepts the model ID: write SillyTavern's native settings.
2. Otherwise, the provider has a gateway adapter: write the Custom OpenAI-compatible source and route through the local gateway.
3. If neither applies: keep the entry visible but not selectable, with a reason (OAuth required, missing API key, no adapter).

| Badge | Source | Route | Server plugin | After removal |
|---|---|---|---|---|
| Native | A provider SillyTavern already supports, and the native control accepts the model | Native settings | No | Preserved |
| Translated | An OMP provider mapped to an ST adapter, and the native control accepts the model | Native settings | No | Preserved |
| OMTP | Catalog provider the native control cannot accept | Custom OpenAI source via the local gateway | Yes | Requires the plugin; stops working if it is removed |
| Profile | Connection Manager extension | Invokes that extension's profile | No | Preserved |

Native/Translated entries write `main_api`, `chat_completion_source` or `textgen_type`, and the model field. OMTP entries write `main_api=openai`, `chat_completion_source=custom`, `custom_url`, and `custom_model`; when gateway auth is on, they also write `custom_include_headers`. `custom_model` is set to `provider/model`, and `custom_url` points at the gateway's `/v1` URL.

## Install

Requires SillyTavern >= 1.12.7 and Node.js >= 18.0.0. Fully compatible with SillyTavern 1.12.7 through 1.19.0+.

1. Place this repository at `SillyTavern/public/scripts/extensions/third-party/omtp-model-hub/`. The folder name must be `omtp-model-hub`; copy it, clone it, or symlink the repository.
2. Optional: copy `server-plugin/` to `SillyTavern/plugins/omtp/`.
3. Enable server plugins in `SillyTavern/config.yaml`:

   ```yaml
   enableServerPlugins: true
   ```

4. Restart SillyTavern and enable **OMTP Model Hub** in the Extensions panel.

With only the client extension, you can browse the catalog and use Native/Translated models, favorites, quick slots, and bindings. OMTP models, catalog refresh, local OMP import, and provider key management require the server plugin.

OMTP does not modify SillyTavern core files.

## Usage

Open the hub from the diagram-project icon in the top bar, `Alt+M`, or **Switch model** in the API drawer. The hotkey is configurable.

### Slash commands

Four commands, modelled on `omp`:

| Command | Effect |
|---|---|
| `/omtp` | Open the hub |
| `/model [selector]` | No argument: open the hub. With one: set the model **and** remember it as the default |
| `/switch [selector]` | No argument: open the compact picker. With one: switch **session-only** |
| `/effort [level]` | No argument: cycle the level. With one: set it |
| `/omtp stats` | Start (or reuse) the local stats dashboard and open it in a new tab |

Selectors accept `provider/model`, a fuzzy id, `@1`-`@9` for a quick slot, `@fav`, and a `:level` suffix such as `opus:high`.

`/switch` follows omp's `setModelTemporary`: the model applies immediately but the saved default selection is left untouched, so the next explicit `/model` or a reload returns to it. The picker is terminal-style — `↑↓` moves with wrap-around, `PgUp`/`PgDn`/`Home`/`End` jump, `Enter` applies, `Esc` clears the query and a second `Esc` closes.

`/effort` cycles `auto → min → low → medium → high → max`, restricted to the levels the current model declares. Unknown values are rejected with the list of what is available, and a model without reasoning support says so.

### Welcome page entry

The first button in Tavern's welcome prompt (originally "API Connections", from `welcomePrompt.html`) is replaced with "OMTP Model Hub" and opens this extension directly; icon and label follow the UI language (`omtp_open_hub`). Every re-render of the welcome message is patched again via a MutationObserver, and disabling/removing the extension restores the original button. The native API connection entry stays available through the plug icon in the left drawer.

### Sign-in

The tab bar carries **All / Favorites / Recent / Profiles / Sign-in / Usage / About**. The **About** tab shows the extension version, the author (BHLuotianyi), the licence (GPL-3.0, linked to the GNU text), the server plugin and SillyTavern versions, the gateway address and the catalog counters (models / providers / generated date), together with what the extension does, where its data comes from and how credentials are kept local. Under the title it notes "This project is a part of SpaghettiTavern Saving Plan", followed by a highlighted "Reference project: OMP (oh-my-pi)" callout (MIT, linking upstream) that credits OMP for the gateway, sign-in flow, usage pages and stats dashboard design. The page closes with an italic line: "We shall meet again at the far shore of the stars".

### OAuth client credentials

The repository ships **no** OAuth client ids or secrets. Catalog entries reference environment variable names only (`OMTP_GOOGLE_ANTIGRAVITY_CLIENT_ID`, …); the values are read locally at runtime, in this order:

1. environment variables (see each entry's `env` array; `OMTP_<PROVIDER>_CLIENT_ID` / `OMTP_<PROVIDER>_CLIENT_SECRET`);
2. `data/omtp/oauth-clients.json`:

```json
{
  "google-antigravity": { "clientId": "…", "clientSecret": "…" },
  "openai-codex": { "clientId": "…" }
}
```

Keep that file at mode `600`; it is git-ignored. Missing values produce a clear error for that provider's OAuth login/refresh only — API-key sign-in, gateway routing and model lists are unaffected. These ids are public application identifiers (and an installed-app client secret is not confidential per RFC 8252 §8.1), but they stay out of the tree to keep scanners and forks clean.

The **Sign-in** tab is OMTP's `/login`: one row per provider with its state (`Signed in · account`, `Not signed in`, `Key rejected · ****last4`) and a single action. States always carry the credential fingerprint and a stored key shows as dots in the field, so "no key" and "rejected key" never look alike. Rows are ordered by login kind (OAuth → device code → custom hook → API key), then by name, and the hub's search box filters this roster directly (name, id and login kind) with an empty-state hint.

- Providers whose OMP policy is `oauth-code` run a real PKCE flow: OMTP opens a loopback listener on the policy's callback port, shows the authorize URL, and accepts a pasted redirect URL or code when the browser cannot reach this machine.
- `device-code` providers show the verification URL and the user code, then poll until the grant completes.
- `api-key` providers get a key field plus a link to their console.
- Clicking Sign in opens the authorize page in a new tab right away: the tab is opened synchronously on the click and navigated once the server returns the URL, so popup blockers do not eat it. When the browser blocks it anyway, the link stays clickable.
- The callback completion/failure page follows the client's language (the client passes `navigator.language` when starting the flow; `Accept-Language` is the fallback).
- Policies that need provider-specific code are implemented as hooks in `server-plugin/lib/custom-logins/`: `openai-codex-device` (Codex headless device flow, credential stored under `openai-codex`), `kilo` (Kilo device flow) and `kimi-fingerprint` (Kimi CLI request headers). The rest (Cursor, GitHub Copilot, Devin, Cloudflare, Snowflake, …) still say so and point at the OMP import.
### Token statistics and estimated cost

A small badge in the chat top bar (`95 token · $0.000146`) shows this chat's running token count and estimated cost; hover for the input/cached/output/reasoning breakdown, click to open the usage page. It refreshes 0.6s after each `generation_ended` and resets when the chat changes. Only requests routed through the OMTP gateway are counted.

The gateway records every completion into `data/omtp/usage-stats.json` (modelled on OMP's run collector): uncached input, cache reads, cache writes, output, reasoning output, request count and an estimated cost. The Usage tab starts with:

- **This chat**: requests / input / cached / output / reasoning / cost, attributed per chat — the gateway tags every record with the `X-OMTP-Chat` header the extension keeps in sync with the open chat, so switching chats (and reloading) shows that chat's own totals.
- **All time**: the same counters since installation.
- **Per model**: the 8 busiest models of the session (falling back to all-time), with their own token breakdown and cost.

Adapters now preserve the provider's cache and reasoning breakdown: Gemini `cachedContentTokenCount` / `thoughtsTokenCount`, Anthropic `cache_read_input_tokens` / `cache_creation_input_tokens`, Bedrock `cacheReadInputTokens` / `cacheWriteInputTokens`, Responses API `input_tokens_details.cached_tokens` — all mapped onto OpenAI's `prompt_tokens_details.cached_tokens` / `cache_write_tokens` and `completion_tokens_details.reasoning_tokens`. A zero in the cached column therefore means the provider reported no cache hits (Gemini's implicit cache needs a ≥1024-token shared prefix and must be reported upstream), not that we dropped the number.

### Local stats dashboard (mirrors `omp stats`)

`/omtp stats` starts a loopback-only HTTP server (port `3847` by default, an ephemeral port when that port is taken) and opens the page in a new tab — a local server serving a stats page, exactly like `omp stats`. The page refreshes every 5 seconds and shows KPI cards (requests, uncached input, cache hits with hit rate, output, reasoning when present, estimated cost) for a selectable range (this chat / last 24 h / since install / all time), a 60-day daily bar chart, a per-model table and a per-chat table with the current chat highlighted and marked ●.

With the range set to "this chat" a session picker appears: it lists every recorded chat (sorted by cost, with request count and cost), and picking one — or clicking a row in the per-chat table — switches the cards and model table to that chat.

Labels follow SillyTavern's UI language (`/omtp stats` forwards `document.documentElement.lang` as `?lang=`, falling back to the browser locale), with built-in English and Chinese dictionaries. The tab icon is an inline SVG data URI (blue square with bars); no external favicon is used.

`server-plugin/lib/stats-server.mjs` owns the server: `ensureStatsServer()` reuses a live instance (identified by the `x-omtp-stats-dashboard` response header), shuts down after 30 idle minutes, and is closed by the plugin's `exit()`; the numbers come from `UsageStats.snapshot()` and the new `UsageStats.dashboard()`.

Costs use each model's `cost` from the catalog (per-million input / output / cacheRead / cacheWrite, inherited from OMP's `models.json`); cache reads are priced at the cache rate. Both streaming and non-streaming replies are counted: the gateway taps the response stream and takes the last `usage` object from SSE `data:` frames or the JSON body.

Endpoint: `GET /api/plugins/omtp/stats` (`?since=<ISO>` limits to what happened after that moment, used for "this chat").

### Usage (mirrors `omp usage`)

The **Usage** tab lists quota consumption per provider, read from each provider's own usage endpoint (`server-plugin/lib/usage.mjs`, modelled on OMP's `packages/ai/src/usage/*`). `/usage` opens that page directly (it switches tabs when the hub is already open).

| Provider | Endpoint | Data |
|---|---|---|
| Google Antigravity / Gemini CLI | `POST /v1internal:retrieveUserQuotaSummary` | weekly / 5-hour windows per model family |
| OpenAI Codex / ChatGPT plans | `GET chatgpt.com/backend-api/wham/usage` | primary/secondary windows + plan |
| Anthropic Claude Pro/Max | `GET api.anthropic.com/api/oauth/usage` | 5-hour / 7-day / per-model + extra-usage balance |
| Z.AI / Zhipu coding plans | `GET api.z.ai/api/monitor/usage/quota/limit` | token / time / credit windows (raw token, no `Bearer`) |
| Kimi Code | `GET api.kimi.com/coding/v1/usages` | used/remaining per window |
| MiniMax Token Plan (intl/CN) | `GET {api.minimax.io|api.minimaxi.com}/v1/token_plan/remains` | 5-hour / weekly per model |
| xAI (SuperGrok) | `GET cli-chat-proxy.grok.com/v1/billing?format=credits` | weekly credits / monthly included / on-demand |
| GitHub Copilot | `GET api.github.com/copilot_internal/user` | premium / chat / completions + reset date |
| OpenCode Go | `GET opencode.ai/zen/go/v1/usage` | 5-hour / weekly / monthly (needs a Go subscription) |
| Cursor | `GET api2.cursor.sh/auth/usage` | billing-cycle request quota (API-key accounts) |
| Command Code | `GET api.commandcode.ai/alpha/billing/credits` (+`/alpha/whoami`) | 5-hour / weekly windows + credits |
| ClinePass | `GET api.cline.bot/api/v1/users/me/plan/usage-limits` | 5-hour / weekly / monthly windows |
| Synthetic | `GET api.synthetic.new/v2/quotas` | rolling 5-hour / weekly windows |
| Umans | `GET api.code.umans.ai/v1/usage` | request window / burst ceiling |
| Charm Hyper | `GET hyper.charm.land/v1/credits` | credit balance |
| DeepSeek | `GET api.deepseek.com/user/balance` | account balance per currency |

- SillyTavern no longer shows "no connection" after a reload: on startup, if the gateway is active, the extension probes it once and marks the connection as Connected.
- Each window shows its name, used percentage, a bar, and a reset countdown; bars turn amber at 70% and red at 90%.
- Readings are cached for 60 seconds; the footer's "Refresh" button forces a new read.
- Providers without credentials, or without a usage endpoint, are omitted (as in omp) instead of guessed; a rejected credential reads "Credentials rejected (HTTP 401)".
- Not implemented: OpenCode Zen (no usage endpoint), the GitHub Copilot API-key billing path, Devin (Connect/protobuf), Ollama (no standalone quota API).

### AA-PersonalityBench scores and radar

Model cards and the details pane surface [AA-PersonalityBench](https://artificialanalysis.ai/evaluations/aa-personalitybench) data from Artificial Analysis:

- Two chips sit next to a model name: `AA 59` is the mean of the eight index percentiles, and `OMTP 62` is a weighted score for roleplay/creative writing (no extra radar).
- The `OMTP` score uses fixed weights: imagination 26% · warmth 20% · expressiveness 18% · non-sycophancy 14% · transparency 7% · conviction 6% · informativeness 5% · organization 4%, minus 8% of slop (`src/personality.js#RP_WEIGHTS`). Transparency matters less overall, but its non-sycophancy half gets its own 14%.
- The `↗` next to the section title opens the AA-PersonalityBench page.
- The details pane draws an eight-axis radar (Expressiveness, Organization, Informativeness, Transparency, Warmth, Conviction, Imagination, Slop) plus a bar per index.
- Data comes from the public evaluation page (41 models) and is bundled as `catalog/personality.json`. AA's free API needs an account and must not be called from client code, so nothing is fetched at runtime.
- AA publishes index percentiles for a subset of models; the rest are derived with AA's documented method (mean trait z-score per index, sycophantic inverted in Transparency, percentile ranked across all 41) and the panel says so. The derivation matches all 88 published values within 0.95.

Refresh the snapshot (page cached under `.cache/`):

```bash
npm run personality          # re-scrape and rewrite catalog/personality.json
npm run personality:verify   # only check the derivation against published values
```

> A GitHub Action or Cloudflare Worker can regenerate this snapshot later and act as OMTP's official data source.

- Quick bar: press **Save to quick bar** on a model card, then left-click any slot 1–9 to place or overwrite it (another slot holding the same model is cleared automatically); right-click clears a slot. Without a pending save, left-clicking a filled slot switches to that model and moves both panes to it (its provider selected on the left, its row scrolled into view and flashed on the right). `Alt+digit` switches, `Alt+Shift+digit` places the selected model.
- `/effort` and SillyTavern's own Reasoning Effort dropdown write the same field (`oai_settings.reasoning_effort`): the command updates the dropdown, and a manual change there wins for the next cycle. With no usable model (none selected, no credential, model without reasoning support) the command no longer errors — it drives that dropdown directly.
- On the Sign-in tab the search box filters both the roster and the provider column (name/id); clicking a provider reveals and highlights its row instead of jumping back to the All tab.
- Switching a model now confirms with a toast ("Now using …"), the row of the model actually in use carries a green bubble, and the footer only reports the usable-model count.
- The filters in the tab row keep a fixed order: "translated provider names" (non-English UIs only) → "only models with scores" → "show non-mainstream providers". The two always-present boxes therefore stay adjacent and right-aligned in every language, with "show non-mainstream providers" always rightmost.
- "Only models with scores" (off by default) keeps just the models that have AA-PersonalityBench data; a provider you opened explicitly is unaffected.
- In non-English UIs a second checkbox, "显示供应商翻译名 / Translated provider names" (on by default), switches provider names to their Chinese form. Only providers with an official Chinese name are translated (DeepSeek→深度求索, Moonshot→月之暗面, Z.AI→智谱国际版, Zhipu→智谱, Xiaomi, SiliconFlow, Qwen, Qianfan, StepFun, NVIDIA, local runtimes); everything else keeps its English name and only the region/qualifier is translated (Cn/China→中国, Singapore→新加坡, Europe→欧洲, International→国际版). See `src/provider-names.js`.
- The "显示非主流供应商 / Show non-mainstream providers" checkbox next to the search box: uncheck it to keep only whitelisted first-party labs, community aggregators (OpenRouter, SiliconFlow, Command Code, OpenCode), coding subscriptions, major clouds and local runtimes (`src/constants.js#MAINSTREAM_PROVIDERS`, 51 of 99). A provider you opened explicitly stays visible.
- A stored key renders as dots inside the field (never the plaintext, and never resubmitted): pressing Save untouched says "that is the stored key", and only an edit replaces it.
- Tokens are stored in the encrypted key store as structured credentials, refreshed with the provider's token endpoint, and used by the gateway.

The model details pane no longer manages credentials; it links to this tab.

### Search and filtering

The search box matches model names, provider names, and `provider/model`. Results rank in this order: exact `provider/model` or exact model ID, favorites, recents, then substring/fuzzy matches. The tabs switch between All, Favorites, Recent, and Profiles; the left column filters by provider. The column mirrors OMP's provider universe (99 providers, including local runtimes such as Ollama/LM Studio/vLLM and OAuth-only plans), so providers without a bundled model list appear too and fill in from the live probe on first click. The column is split in two by a thin rule: first-party AI labs on top (Anthropic, OpenAI / ChatGPT plans, Google, xAI, DeepSeek, Mistral, Meta, Moonshot, Z.AI, MiniMax, Qwen/Alibaba, Xiaomi, NVIDIA, Perplexity, StepFun, …; `src/constants.js#LAB_PROVIDERS`), aggregators, clouds and local runtimes below. Each part is ordered green (signed in) → red (the provider rejected the stored key, detected by the startup probe and by any failed refresh) → hollow (no credentials), alphabetical within a state. Search results are grouped by provider, each section header showing the match count and a "🔄 Refresh live models" button, in ranking order (best match first). Searching narrows the provider column to the providers that own a match, and filters inside the selected provider (telling you how many matches live elsewhere). Choosing a provider replaces the list with that provider's models and selects its first model (highlight plus details pane); Recent and Favorites only appear on the All view.

With an entry selected, the details pane offers:

- **Use model** switches immediately. It refuses to switch during generation.
- **Favorite**, **Quick slot**, **Bind chat**, **Bind character**.
- **Edit extra body**: stores a JSON object for the entry and merges it into the request body at generation time. `model`, `messages`, `prompt`, `stream`, and API routing keys are managed by OMTP and cannot be overridden.
- **Provider settings** jumps to that provider's row in the hub's **Providers** tab.
- Providers that support both a subscription login and an API key (Anthropic Claude Pro/Max, GitHub Copilot, …) show both: an OAuth section plus the key field. When the credential only exists in the gateway (an imported OAuth session), those models route through the gateway instead of SillyTavern's native adapter.
- **Get API key** opens the provider's console page where a key is created (shown for the providers that publish one).
- **Copy selector** copies `provider/model` for OMTP entries and the model/profile ID for others.

### Quick slots and shortcuts

Nine quick slots sit at the top of the panel. `Alt+1..9` switches to a slot, `Alt+Shift+1..9` assigns the current selection to a slot, and right-clicking a slot clears it.

### Bindings

Chat bindings live in the current chat's `chat_metadata.omtp` and travel with the chat. Character bindings are stored per avatar in extension settings. On chat changes, a chat binding wins over a character binding; character bindings do not apply in group chats. Auto-apply is on by default and can be disabled in settings.

### Reasoning effort

The detail pane stores reasoning effort (`auto`, `min`, `low`, `medium`, `high`, `max`) per entry. It writes `openai_reasoning_effort` only when `main_api=openai`; other APIs ignore it.

### Gateway mode

Gateway providers are always listed: unlocked providers (usable credentials, or keyless) sit above the separator with their model counts, locked ones below it. Selecting a gateway model writes SillyTavern's Custom (OpenAI-compatible) source. Before selecting one, check that:

- the server plugin is running;
- the provider has usable credentials (or is keyless);
- you accept that the selection stops working if the server plugin is removed.

Otherwise the entry shows why it is unavailable and **Use model** stays disabled.

### Selector strings

The search box does not parse `@` syntax. These forms are for `globalThis.OMTP.switchTo()` and other extensions:

```js
await OMTP.switchTo('provider/model');
await OMTP.switchTo('@1');
await OMTP.switchTo('@fav');
await OMTP.switchTo('provider/model:high');
```

Supported: `provider/model` (split at the first `/`; the model ID itself may contain `/`), `@1`–`@9`, `@fav`/`@favorites`, `@recent`/`@recents`, bare model IDs, and `:auto`/`:min`/`:low`/`:medium`/`:high`/`:max` reasoning suffixes. `@fav` and `@recent` use the first entry that is still available.

## Native selector

The native SillyTavern API selector is hidden by default. This only adds `omtp-hide-native-api-selector` to `<body>`, and CSS hides `#main-API-selector-block`; no native control is removed, reparented, or rebuilt.

To restore it:

- uncheck **Hide native API selector** in settings;
- or click **Show native API selector** in the API drawer;
- or disable/delete the extension and reload the page, after which the class is gone and the native selector returns.

The API drawer, keys, provider settings, Connection Profiles, and slash commands remain functional.

## Switching and recovery

Native/Translated selections are written directly to SillyTavern settings and remain valid after OMTP is removed.

The first switch from non-gateway to gateway mode snapshots the current Custom source fields. Leaving gateway mode restores that snapshot; disabling, cleaning, or deleting the extension makes the cleanup hook try to restore the last native selection or the saved Custom state.

Gateway selections live in SillyTavern's Custom source. They stop working when the server plugin is removed. If only the client extension is removed, the fields remain and may keep working, but OMTP no longer manages them. If the extension folder is deleted without running the cleanup hook, switch back to the native API selector manually or restore the Custom source fields yourself.

## Server plugin

The server plugin is optional. When enabled, it starts with SillyTavern by default and exposes an OpenAI-compatible gateway on `127.0.0.1`. It does not start any OMP process or binary.

The default URL is `http://127.0.0.1:4100/v1`. If the port is busy, it falls back within `4100`–`4110`. Bearer auth is on by default.

| Endpoint | Purpose | Auth |
|---|---|---|
| `GET /health` | Health check | None |
| `GET /v1/models` | List gateway-accessible `provider/model` entries | Bearer by default |
| `POST /v1/chat/completions` | Chat completions, streaming and non-streaming | Bearer by default |

The settings panel can change the client-side gateway URL, toggle auto-start and token auth, and restart the gateway. The client prefers the actual URL returned by the plugin's `/status` endpoint, so port fallback does not require a client change.

### State and keys

State lives under `$DATA_ROOT/omtp`; SillyTavern usually points `DATA_ROOT` at `SillyTavern/data`, so the common path is `SillyTavern/data/omtp/`.

| File | Contents |
|---|---|
| `config.json` | `autoStart`, `port`, `requireAuth` |
| `gateway-token` | Generated Bearer token |
| `providers.json` | Encrypted provider configs (including API keys) |
| `master.key` | AES-256-GCM key for `providers.json` |
| `catalog.json` | Refreshed catalog |
| `imported-catalog.json` | Overlay from local OMP import |

Provider keys resolve in this order: OMTP key store → SillyTavern secrets (default user) → catalog environment variables. The HTTP API never returns provider keys in plaintext; the settings page shows only the source and last four characters.

### Protocol adapters

| Adapter | Upstream protocol |
|---|---|
| `openai` | OpenAI Chat Completions and compatible APIs |
| `anthropic` | Anthropic Messages |
| `google` | Google Generative AI |
| `google-vertex` | Google Vertex AI |
| `responses` | OpenAI Responses |
| `azure-responses` | Azure OpenAI Responses |
| `bedrock` | Amazon Bedrock Converse (static AWS credentials; streaming responses are synthesized) |
| `ollama` | Ollama chat |

Providers that only support OAuth/agent protocols do not use the gateway: Cursor, Devin, GitLab Duo, GitLab Duo Agent, OpenAI Codex, Gemini CLI, Antigravity, GitHub Copilot, and xAI Grok OAuth. They appear with an unavailable reason and cannot be selected.

### Custom providers

The Providers section can add a custom provider with an id, adapter, base URL, models JSON, and optional API key. Once saved, it can be tested; custom providers merge into the catalog, and their models appear in the gateway's `/v1/models` when credentials are available. Advanced settings override headers and extraConfig.

### Multi-user

The gateway targets SillyTavern's default single-user mode. With multi-user accounts enabled, gateway provider keys are shared (the key store is global, and ST secrets are read from the default user's directory); there is no per-user isolation.

## Catalog

The bundled catalog is a snapshot of OMP's model data, generated by `tools/build-catalog.mjs` and written to both the client and server copies.

```bash
node tools/build-catalog.mjs --omp-root /path/to/oh-my-pi
node tools/validate-catalog.mjs
```

`--omp-root` points at an OMP checkout containing `packages/catalog/src/models.json` and `packages/catalog/src/compat/rules.json`. The build validates provider count, model count, native adapter keys, and that every provider has an adapter or an unavailable reason; `validate-catalog.mjs` also checks provider-map coverage.

The current snapshot has 79 providers and 5,710 chat models. Only `kind: chat` is kept; image, speech, embedding, and other non-chat models are excluded. Providers with no chat models stay in the catalog but produce no panel entries.

**Refresh catalog** accepts `http:`/`https:` URLs; leaving it blank fetches from OMP upstream. Validation or network failures keep the current catalog. **Import local OMP** in settings reads a given checkout and writes an overlay (`imported-catalog.json`), with an optional toggle to securely import API-key credentials from `~/.omp/agent/agent.db` into OMTP's encrypted key store; it never overwrites the bundled catalog and never executes `omp`.

## Development

```bash
npm test                 # node --test tests/unit
npm run validate         # validate the bundled catalog
npm run mock             # mock OpenAI provider on 127.0.0.1:4199
```

The mock provider serves an `echo` model and replies `pong` to requests containing `ping`. Add a custom provider in the hub's Providers tab with id `mock`, adapter `openai`, base URL `http://127.0.0.1:4199/v1`, model `echo`, and any non-empty key to exercise the gateway without a real API.

Manual end-to-end checks are in `tests/e2e/README.md`. The selector/resolution notes in `model-selection-omp/` describe OMP; they are reference material, not OMTP runtime documentation.

## Limitations

- Chat models only. The catalog excludes non-chat modalities, and the panel only lists catalog models, so SillyTavern native multi-select features such as AI Horde are not exposed there.
- Native `<select>` options are never modified. A model absent from the native control either uses the gateway or is marked unavailable.
- Gateway selections depend on the server plugin; they stop working when the plugin is removed. Native/Translated selections are unaffected.
- OAuth/agent protocols and multi-user gateway key isolation are not implemented.
- The bundled catalog is a point-in-time snapshot; use catalog refresh or local OMP import for newer models.

## License

GPL-3.0 (GNU General Public License v3.0), © 2026 BHLuotianyi. Author: [BHLuotianyi](https://github.com/BHLuotianyi).

The bundled catalog is derived from OMP's MIT-licensed data; see `NOTICE`.
