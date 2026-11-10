English | [简体中文](./CONTRIBUTING.md)

# Contributing

This guide describes how OMTP is structured, the invariants it must keep, and how to submit changes.

## Structure

OMTP consists of two parts that are deployed separately:

- **Client extension**: `index.js`, `src/`, `settings.html`, `style.css`, `i18n/`, `catalog/`. Runs in the browser and imports SillyTavern modules (`script.js`, `extensions.js`, `popup.js` and others) by relative path. There is no build step.
- **Server plugin**: `server-plugin/`. Users copy it to `SillyTavern/plugins/omtp/`, where it runs in SillyTavern's Node process.

Nothing at runtime calls the `omp` program or needs Python. Reading credentials from a local OMP tries `node:sqlite`, then the `sqlite3` command, then `python3`; without any of them that one feature is unavailable and everything else keeps working.

```text
index.js                 extension entry, forwards to src/ui/hub.js
settings.html            settings panel template; element ids are used by src/ui/settings.js
i18n/                    UI strings (en, zh-cn)
catalog/                 catalog and personality snapshot used by the client
src/
  catalog.js             catalog loading and merging, connection path, live model cache
  switch-engine.js       writing SillyTavern settings, entering and leaving gateway mode
  selector.js            selector parsing and ranking
  store.js               extension settings and EntryRef
  public-api.js          globalThis.OMTP
  slash-commands.js      slash commands
  update-check.js        update decision
  adapters/native.js     descriptions of SillyTavern's native sources
  ui/                    panel, sign-in, usage, settings, bindings and other UI modules
server-plugin/
  index.mjs              plugin entry and management API
  catalog/               the plugin's own catalog copy
  lib/
    gateway-server.mjs   gateway
    adapters/            upstream protocol adapters
    key-store.mjs        encrypted key store and credential resolution
    login-engine.mjs     OAuth and device-code sign-in
    catalog-service.mjs  server-side catalog layering
    usage.mjs            quota queries
    stats.mjs            usage statistics and cost
    proxy-fetch.mjs      outbound proxy
tools/                   catalog build and validation, personality data, version scripts
tests/unit/              unit tests
tests/fixtures/          local mock provider
docs/                    documentation
```

## Development setup

- Node.js 18 or later. No `npm install` is needed: the client and the tests use Node built-ins only, and the plugin uses the `express` that ships with SillyTavern.
- To debug in a real SillyTavern, clone (or link) the repository into `public/scripts/extensions/third-party/omtp-model-hub/` and copy `server-plugin/` to `plugins/omtp/`. After changing plugin code, copy it again and restart SillyTavern.

```bash
npm test                    # unit tests
npm run validate            # catalog validation
npm run mock                # local mock provider, see docs/testing.en.md
npm run catalog -- --omp-root /path/to/oh-my-pi   # regenerate the catalog
npm run personality         # refresh the personality snapshot
npm run personality:verify  # only check the index derivation
```

## Invariants

1. **Standalone plugin**: `server-plugin/` must not import files from the repository root or `src/`; constants and catalogs needed on both sides are kept in two copies. The `../../src/…` imports in `server-plugin/index.mjs` refer to SillyTavern's own modules.
2. **Host-free modules**: `src/constants.js`, `src/selector.js`, `src/personality-match.js`, `src/update-check.js`, `src/profile-fields.js` and `src/reasoning.js` must not import SillyTavern modules; unit tests load them directly in Node.
3. **Identical catalogs**: `catalog/omtp-catalog.json` and `server-plugin/catalog/omtp-catalog.json` must be byte-identical. `npm run catalog` writes both, `npm run validate` checks them.
4. **Matching string keys**: `i18n/en.json` and `i18n/zh-cn.json` have the same keys. Add new strings to both. Keys such as `omtp_pb_*`, `omtp_source_*`, `omtp_stats_col_*` and `omtp_tab_*` are built in code; do not delete them because a search finds no literal use.
5. **Consistent versions**: the four version files are written by `tools/version.mjs`; do not edit them by hand. See [Versions and releases](./docs/releasing.en.md).
6. **Credentials**:
   - No real API keys, tokens or personal paths in code, catalogs or test data.
   - OAuth client values in the catalog are public identifiers; whether they ship is decided by `LOCAL_ONLY_CLIENTS` in `server-plugin/lib/catalog-normalize.mjs`. Explain any change to it in the PR.
   - `key-store.mjs` must throw `KeyStoreUnreadableError` (409 from the management API) on data it cannot decrypt, and must never overwrite the user's `providers.json` or regenerate `master.key`.
   - Gateway tokens are compared in constant time with `tokensEqual`.
7. **Switch and restore order**: the order in which `switch-engine.js` writes SillyTavern controls and waits for them, saving the Custom OpenAI settings before entering gateway mode, and the `restorePreviousSelection → cleanupHubSurfaces → resetHubState` order on teardown in `src/ui/hub.js` must not change.
8. **Usage accounting**: adapters report `completion_tokens` including reasoning tokens, with the reasoning count in `completion_tokens_details.reasoning_tokens`. Cost estimation depends on it; see the [server plugin reference](./docs/gateway.en.md#usage-statistics-and-cost).

## Catalog and personality data

- **Catalog**: `tools/build-catalog.mjs` reads `packages/catalog/src/models.json` (compact format, decoded by `server-plugin/lib/omp-models-format.mjs`) and `compat/rules.json` from an OMP checkout and combines them with `tools/provider-map.source.json` (which maps providers to SillyTavern native sources and gateway adapters) and `tools/native-adapter-keys.json` to produce both catalogs. Only chat models are kept.
- **Client versions**: `server-plugin/lib/client-versions.mjs` holds every impersonated client version (Claude Code, Gemini CLI, Antigravity, Kimi CLI). They follow OMP and are bumped together with the catalog: a stale version makes Anthropic reject new models ("version X or newer is required") and Antigravity hide them.
- When the number of providers or models changes, update `CATALOG_EXPECTATIONS` in `server-plugin/lib/catalog-normalize.mjs`, or `npm run validate` fails.
- **Personality scores**: `tools/fetch-personality.mjs` parses the AA-PersonalityBench page into `catalog/personality.json`, caching the page in `.cache/`. AA publishes the eight index values for some models only; for the rest they are derived from the published trait scores following AA's method, and every run prints published-versus-derived differences.

## Code style

- ES modules: `.js` for the client, `.mjs` for the plugin and tools.
- Four-space indentation, single quotes, semicolons.
- Short JSDoc on exported functions.
- Comments explain why (intent, edge cases, host quirks), not what the code says.

## Tests

Before submitting, run `npm test` and `npm run validate`, and `node --check` on changed `.js` / `.mjs` files.

Tests should catch real problems: business rules, protocol translation edge cases, encrypted storage, fixed bugs. Do not write tests that only inspect source text, echo a mock, or assert that something does not throw. Tests must be deterministic, independent and free of network access.

Manual checks and the mock provider are described in [Testing](./docs/testing.en.md).

## Documentation

| Change | Update |
|---|---|
| User-visible features or settings | `docs/user-guide*.md`, the README if needed |
| Plugin API, data files, environment variables, security behavior | `docs/gateway*.md` |
| `globalThis.OMTP` or selectors | `docs/developer*.md` |
| Versioning or release process | `docs/releasing*.md` |

Change the Chinese and English documents together. Describe current behavior in plain terms, without marketing language. Avoid numbers that go stale (provider or route counts); when one is needed, say where it comes from.

## Pull requests

1. Fork the repository and branch from `main`, e.g. `fix/gateway-port` or `feat/provider-foo`.
2. Make the change and pass the checks above.
3. Verify UI changes in SillyTavern and attach screenshots or recordings to the PR.
4. Fill in the PR template. Commit messages follow Conventional Commits (`fix(scope): …`, `feat(scope): …`, `docs: …`).
