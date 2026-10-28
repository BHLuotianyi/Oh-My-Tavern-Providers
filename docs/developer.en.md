[English](./developer.en.md) | [简体中文](./developer.md) | [Back to README](../README.en.md)

# Developer API, Selectors & Build Guide

This guide covers the `globalThis.OMTP` runtime API, selector grammar, offline catalog build scripts, and local mock debugging for third-party SillyTavern extension authors and contributors.

---

## 1. Runtime API (`globalThis.OMTP`)

While enabled, OMTP installs `globalThis.OMTP` (and restores or deletes it on teardown if still owned by this module):

| Member | Signature / Type | Description |
|---|---|---|
| `version` | `string` | Extension version (`0.1.0`) |
| `open(options?)` | `Function` | Opens the hub modal (accepts `{ tab: 'all' \| 'favorites' \| 'recent' \| 'profiles' \| 'providers' \| 'usage' \| 'about' }`) |
| `close()` | `Function` | Closes the hub modal |
| `toggle()` | `Function` | Toggles the hub modal |
| `getCurrentSelection()` | `() => EntryRef \| null` | Returns the active `EntryRef` (`{ kind, provider, model }`), **not** a full catalog entry object |
| `switchTo(selectorOrRef, { persist = true })` | `async (string\|object, object?) => EntryRef` | Resolves a selector string or `EntryRef` and switches to it (`persist: false` switches session-only); returns the `EntryRef` |
| `registerProviderAdapter(adapter)` | `(object) => object` | Registers a custom SillyTavern native adapter at runtime (requires `adapter.key`) and emits `omtp:catalog-changed` |
| `registerCatalogProvider(provider)` | `(object) => object` | Merges a provider overlay into the active catalog, rebuilds entries, and emits `omtp:catalog-changed` |
| `on(event, handler)` | `(string, Function) => () => void` | Subscribes to an OMTP event and returns an unsubscribe function |
| `off(event, handler)` | `(string, Function) => void` | Unsubscribes an event handler |
| `events` | `{ SELECTION_CHANGED, CATALOG_CHANGED }` | Event constants (`'omtp:selection-changed'`, `'omtp:catalog-changed'`) |
| `roles` | `object` | Reserved namespace for future role integrations |

### Example

```javascript
// 1. Switch model and persist as default
await OMTP.switchTo('anthropic/claude-opus-5-5:high');

// 2. Session-only switch (equivalent to /switch)
await OMTP.switchTo('@1', { persist: false });
await OMTP.switchTo('@fav');

// 3. Read current selection reference
const ref = OMTP.getCurrentSelection();
// => { kind: 'st', provider: 'anthropic', model: 'claude-opus-5-5' }

// 4. Listen for selection changes (reasoning level is applied before the event fires)
const unsubscribe = OMTP.on(OMTP.events.SELECTION_CHANGED, ({ ref, entry, gateway, reason }) => {
    console.log(`[OMTP] switched to ${ref.provider}/${ref.model} (gateway=${gateway}, reason=${reason})`);
});
```

---

## 2. Selector Grammar (`resolveSelector`)

Selectors are accepted by `OMTP.switchTo()`, `/model`, and `/switch` (the hub search box performs substring/fuzzy filtering directly and does not parse `@` tokens):

| Pattern | Resolution Rule | Examples |
|---|---|---|
| `provider/model` | Splits on the **first** `/`; the model ID itself may contain additional `/` characters | `anthropic/claude-opus-5-5`<br/>`openrouter/deepseek/deepseek-v4.1-flash-1017` |
| `@1` .. `@9` | Quick slot 1–9 (returns an error if the slot is empty or its target model is unavailable) | `@1`, `@3` |
| `@fav` / `@favorites` | First entry in the favorites list that is currently available (`available !== false`) | `@fav` |
| `@recent` / `@recents` | First entry in the recent-models list that is currently available | `@recent` |
| `:level` suffix | Appends `:auto`, `:min`, `:low`, `:medium`, `:high`, or `:max` to any selector | `claude-opus-5-5:high`<br/>`@1:medium` |
| Bare model ID / query | Exact `key` or exact `model` ID first, then ranked by favorites > recents > substring offset | `gemini-4-argon` |

---

## 3. Catalog Build & AA-PersonalityBench Scripts

The bundled catalog contains **99 providers and 5,770 chat models** (`kind: 'chat'` only) plus **41 models** in the AA-PersonalityBench snapshot.

```bash
# 1. Rebuild both catalog copies from an oh-my-pi checkout (defaults to ~/oh-my-pi)
npm run catalog -- --omp-root /path/to/oh-my-pi

# 2. Validate both catalog copies, counts, 44 native adapter keys, and byte equality
npm run validate

# 3. Re-scrape and write catalog/personality.json (cached under .cache/)
npm run personality

# 4. Verify derived personality index percentiles against published values
npm run personality:verify
```

> **Why are there two identical `omtp-catalog.json` files?**
> `catalog/omtp-catalog.json` is fetched by the browser extension, while `server-plugin/catalog/omtp-catalog.json` ships inside `server-plugin/` so the plugin remains self-contained when copied to `SillyTavern/plugins/omtp/`. `tools/build-catalog.mjs` writes both, and `tools/validate-catalog.mjs` enforces byte equality.

---

## 4. Unit Tests & Zero-Cost Mock Debugging

```bash
# Run unit tests via Node's built-in test runner
npm test

# Start the local mock OpenAI server on http://127.0.0.1:4199/v1
npm run mock
```

**Testing the gateway end-to-end without real API keys**:
1. Run `npm run mock` (serves model `echo`, replying `pong` when the prompt contains `ping`, both streaming and non-streaming).
2. Open the OMTP Hub → **Sign-in** tab → click **Add custom provider** at the bottom:
   - **ID**: `mock`
   - **Adapter**: `openai`
   - **Base URL**: `http://127.0.0.1:4199/v1`
   - **Models JSON**: `echo`
   - **API key**: any non-empty string (e.g. `x`)
3. Select `mock/echo` in the **All** tab and send a message. For the full manual checklist, see [`tests/e2e/README.md`](../tests/e2e/README.md).
