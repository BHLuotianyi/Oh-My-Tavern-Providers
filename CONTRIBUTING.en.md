[English](./CONTRIBUTING.en.md) | [简体中文](./CONTRIBUTING.md)

# Contributing to OMTP Model Hub

Thank you for contributing to **OMTP Model Hub (Oh-My-Tavern-Providers)**!
This guide documents the architecture boundaries, development workflow, quality guardrails, and pull request requirements for both the **SillyTavern client extension (`src/` + `index.js`)** and the **optional server plugin (`server-plugin/`)**.

---

## Scope & Architecture Boundaries

- **Purpose**: OMTP provides a unified model hub modal and an optional local protocol-translation gateway for SillyTavern 1.12.7+.
- **Two Standalone Layers**:
  - **Client Extension (`src/`, `index.js`, `style.css`, `settings.html`, `i18n/`)**: Runs in the browser, importing SillyTavern host modules (`script.js`, `extensions.js`, `popup.js`, `events.js`, etc.) via relative ES module specifiers with zero build/bundler step.
  - **Server Plugin (`server-plugin/`)**: Copied standalone into `SillyTavern/plugins/omtp/`. **`server-plugin/` must never import files from `src/` or the repository root**; shared constants or catalog files must remain self-contained inside `server-plugin/`.
- **Zero External Binaries**: Never spawn or require the `omp` binary or a Python environment at runtime. Everything is implemented in pure JavaScript / Node.js.

---

## Documentation Map

When your changes affect user-facing behavior, routes, or APIs, update the corresponding documentation in lockstep:

| Document | Audience & Purpose |
|---|---|
| [`README.md`](./README.md) / [`README.en.md`](./README.en.md) | User overview, highlights, 30-second install, 3-minute quick tour, key features, and FAQ |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) / [`CONTRIBUTING.en.md`](./CONTRIBUTING.en.md) | Module boundaries, coding conventions, guardrails, and PR workflow |
| [`docs/gateway.md`](./docs/gateway.md) / [`docs/gateway.en.md`](./docs/gateway.en.md) | Gateway listener & auth, all 24 plugin HTTP routes, 9 protocol adapters, 16 quota endpoints, `data/omtp/` specs |
| [`docs/developer.md`](./docs/developer.md) / [`docs/developer.en.md`](./docs/developer.en.md) | `globalThis.OMTP` surface, selector grammar, catalog & personality build scripts, local mock server |
| [`tests/e2e/README.md`](./tests/e2e/README.md) | Manual end-to-end verification checklist inside a live SillyTavern instance |

---

## Development Environment & Scripts

- **Node.js**: `>= 18.0.0` (Node.js 20+ / 22+ recommended for running unit tests via built-in `node --test` and `node:sqlite`)
- **SillyTavern**: `>= 1.12.7` (compatible through `1.19.0+`)
- **Dependencies**: Zero third-party npm dependencies are required to run the client extension or the unit test suite; `server-plugin/` reuses SillyTavern's bundled `express` at runtime.

### Common Commands

```bash
# 1. Run the full unit test suite (Node built-in test runner)
npm test

# 2. Validate both bundled catalog copies (counts, 44 native adapter keys, byte equality)
npm run validate

# 3. Rebuild both catalog copies from a local oh-my-pi checkout (defaults to ~/oh-my-pi)
npm run catalog -- --omp-root /path/to/oh-my-pi

# 4. Verify or re-scrape the AA-PersonalityBench snapshot (catalog/personality.json)
npm run personality:verify
npm run personality

# 5. Start the local mock OpenAI server on http://127.0.0.1:4199/v1
npm run mock
```

---

## Project Layout

```text
Oh-My-Tavern-Providers/
├── index.js                      # Client extension entry point (calls hub.init())
├── settings.html                 # Extension settings drawer markup (element IDs are the binding contract)
├── style.css                     # Styles for the hub modal, sign-in, usage, quick picker, and settings
├── i18n/
│   ├── en.json                   # English locale (key set must match zh-cn.json 1:1)
│   └── zh-cn.json                # Simplified Chinese locale
├── catalog/
│   ├── omtp-catalog.json         # Client catalog (byte-identical to server-plugin/catalog/omtp-catalog.json)
│   └── personality.json          # AA-PersonalityBench 8-axis snapshot (41 models)
├── src/                          # Client core & UI modules (ES Modules)
│   ├── constants.js              # Route constants, mainstream providers (52), lab providers (33), event names
│   ├── store.js                  # extension_settings.omtp persistence, EntryRef validation & getEntryKey
│   ├── catalog.js                # Catalog loader, multi-layer merge, native/gateway routing, live model cache
│   ├── selector.js               # Pure selector lexer, parser, and ranker (NO SillyTavern imports allowed)
│   ├── switch-engine.js          # Switch engine: native writes, Custom snapshot/restore, switch lock, chat header
│   ├── public-api.js             # globalThis.OMTP installer and teardown
│   ├── slash-commands.js         # /omtp, /model, /switch, /effort, /usage slash commands
│   ├── personality.js            # 8-axis radar SVG renderer and OMTP roleplay score calculation
│   ├── personality-match.js      # Pure model ID -> personality key matcher
│   ├── provider-names.js         # Localized Chinese provider names and region qualifiers
│   ├── provider-links.js         # Provider API-key console URLs
│   ├── errors.js                 # Switch/selector error codes (translated in the UI layer)
│   ├── reasoning.js              # Reasoning effort capability helpers
│   ├── usage-session.js          # Per-chat token accounting session baseline
│   ├── events.js                 # Host event bridge and cleanup
│   ├── adapters/
│   │   └── native.js             # 44 SillyTavern native adapter definitions (frozen objects)
│   └── ui/
│       ├── helpers.js            # Shared UI helpers (el, isPlainObject, notify, formatTokens, formatUsd)
│       ├── dom.js                # i18n tr/trf, top-bar & API-drawer button injection, global hotkeys
│       ├── hub.js                # Hub facade (init/teardown lifecycle, event wiring, public re-exports)
│       ├── hub-state.js          # Shared mutable state singleton across hub-* modules
│       ├── hub-utils.js          # Entry/ref keys, favorite/recent/slot helpers
│       ├── hub-catalog.js        # Hub catalog loader, provider bucketing, mainstream/scored filters
│       ├── hub-sidebar.js        # Left provider column, search filtering, live-model refresh
│       ├── hub-list.js           # Center model list, grouped search results, tab views
│       ├── hub-details.js        # Right details pane, personality radar, reasoning & action buttons
│       ├── hub-quick.js          # Top 1–9 quick slot bar, row flash, footer counters
│       ├── hub-actions.js        # Use model, chat/character binding toggles, provider settings jump
│       ├── hub-modal.js          # Modal DOM builder, gateway status pill, keyboard navigation & focus trap
│       ├── login-panel.js        # Sign-in tab (OAuth PKCE / device code / custom hooks / API key entry)
│       ├── usage-panel.js        # Quota bars and per-chat / all-time token statistics table
│       ├── usage-chip.js         # Top-bar token & estimated cost badge
│       ├── about-panel.js        # About tab (versions, gateway URL, credits, license)
│       ├── quick-picker.js       # Compact keyboard picker for bare `/switch`
│       ├── settings.js           # Extension settings drawer, custom provider popup, local OMP import popup
│       ├── bindings.js           # Auto-apply chat & character bindings state machine
│       └── extra-body.js         # Per-entry extra-body JSON editor and generation payload merge hook
├── server-plugin/                # Optional SillyTavern server plugin (copied to plugins/omtp/)
│   ├── index.mjs                 # Plugin entry: registers 24 /api/plugins/omtp routes, manages gateway & stats
│   ├── catalog/omtp-catalog.json # Bundled server catalog copy (byte-identical to catalog/omtp-catalog.json)
│   └── lib/
│       ├── config.mjs            # data/omtp root, config.json I/O, atomic writes, gateway token check
│       ├── gateway-server.mjs    # Standalone OpenAI-compatible gateway (127.0.0.1:4100–4110) & usage tap
│       ├── gateway-ports.mjs     # Gateway port acquisition/reuse (cross-instance token check)
│       ├── key-store.mjs         # AES-256-GCM KeyStore (providers.json + master.key) & 3-tier key resolution
│       ├── provider-config.mjs   # Provider context builder, supported adapter checks, probe descriptors
│       ├── catalog-service.mjs   # Layered server catalog (bundled -> cached -> imported -> custom)
│       ├── catalog-normalize.mjs # OMP catalog normalizer & validateCatalog
│       ├── login-engine.mjs      # OAuth PKCE loopback listener, callback policy, device-code poller, custom hooks
│       ├── after-exchange.mjs    # Post-exchange hooks (Z.ai key minting, Google project id, Anthropic identity)
│       ├── oauth.mjs             # Structured OAuth credential parser and token refresh
│       ├── oauth-clients.mjs     # Local OAuth client credential resolver (env -> oauth-clients.json)
│       ├── import-omp.mjs        # Local oh-my-pi catalog & agent.db SQLite credential importer
│       ├── usage.mjs             # 21 providers across 16 quota adapters with 60s caching
│       ├── stats.mjs             # Token & cache/reasoning cost calculator and persistent ledger
│       ├── stats-server.mjs      # /omtp stats local dashboard HTTP server (default port 3847)
│       ├── sse.mjs               # OpenAI SSE parser and frame builders
│       ├── redact.mjs            # Console logging helpers
│       ├── proxy-fetch.mjs       # Environment-proxy-aware fetch wrapper (HTTP CONNECT tunnel + direct fallback)
│       ├── custom-logins/        # openai-codex-device, kilo, and kimi-fingerprint hooks
│       └── adapters/             # 9 protocol adapters (openai, anthropic, google, google-vertex, antigravity, responses, azure-responses, bedrock, ollama)
├── tools/                        # Maintenance scripts (build-catalog, validate-catalog, fetch-personality)
└── tests/                        # Unit tests (tests/unit/*.test.mjs) and mock upstream (tests/fixtures/)
```

---

## Quality Guardrails

Before opening a pull request, verify that these invariants hold:

1. **Host-Free Pure Modules**:
   - `src/selector.js` and `src/personality-match.js` must remain completely free of SillyTavern host imports so they can be imported directly in Node.js unit tests.
2. **Byte-Identical Catalog Copies**:
   - `catalog/omtp-catalog.json` and `server-plugin/catalog/omtp-catalog.json` must remain byte-for-byte identical. Always run `npm run validate` after touching catalog tooling.
3. **Lockstep Locale Files**:
   - `i18n/en.json` and `i18n/zh-cn.json` must have identical key sets and ordering. Keep dynamic key families (`omtp_pb_*`, `omtp_source_*`, `omtp_stats_col_*`) intact.
4. **Security & KeyStore Safety**:
   - Never commit **user credentials**: API keys, OAuth access/refresh tokens, or machine-specific file paths.
   - Installed-app OAuth `client_id` / `client_secret` values are public identifiers (RFC 8252 §8.1); whether the catalog embeds them is governed by `LOCAL_ONLY_CLIENTS` in `catalog-normalize.mjs`. Justify any change in the PR, and never ship a user token.
   - `KeyStore` must throw `KeyStoreUnreadableError` (mapped to HTTP `409`) when ciphertext cannot be decrypted—never overwrite an unreadable `providers.json`.
   - Gateway Bearer token comparison must use constant-time `tokensEqual`.
5. **Non-Destructive Switch & Teardown Order**:
   - Preserve the control-write + `waitFor` ordering in `switch-engine.js`, the `savedCustom` snapshot before entering gateway mode, and the `restorePreviousSelection -> cleanupHubSurfaces -> resetHubState` teardown sequence in `hub.js`.

---

## Code Style & Testing Policy

- **Code Style**:
  - ES Modules (`.js` in `src/`, `.mjs` in `server-plugin/`, `tools/`, `tests/`).
  - **4-space indentation**, single quotes, semicolons, concise JSDoc comments.
  - Omit comments that merely restate the code; document non-obvious invariants, protocol quirks, and SillyTavern host behaviors.
- **Testing**:
  - Run `npm test`, `npm run validate`, and `node --check` on all touched files.
  - Write focused behavioral tests that catch real regressions (protocol translation, key resolution, selector edge cases); avoid brittle source-text or mock-echo tests.
