English | [简体中文](./developer.md) | [Back to README](../README.en.md)

# Developer API

This document is for people writing SillyTavern extensions or scripts that call OMTP. To work on OMTP itself, see [Contributing](../CONTRIBUTING.en.md).

## `globalThis.OMTP`

While the extension is enabled, OMTP installs `OMTP` on the global object. When the extension is disabled and `globalThis.OMTP` is still the object OMTP installed, it is removed and any previous value is restored.

| Member | Signature | Description |
|---|---|---|
| `version` | `string` | Extension version, same as `manifest.json` |
| `open` | `(options?) => void` | Open the panel. `options.tab` may be `all`, `favorites`, `recent`, `profiles`, `providers`, `usage`, `about` |
| `close` | `() => void` | Close the panel |
| `toggle` | `() => void` | Toggle the panel |
| `getCurrentSelection` | `() => EntryRef \| null` | The current model |
| `switchTo` | `(selectorOrRef, { persist = true }?) => Promise<EntryRef>` | Switch the model, see below |
| `registerProviderAdapter` | `(adapter) => object` | Register an adapter for a SillyTavern native source |
| `registerCatalogProvider` | `(overlay) => catalog` | Merge providers into the active catalog; returns the merged catalog |
| `on` | `(event, handler) => () => void` | Subscribe; returns an unsubscribe function |
| `off` | `(event, handler) => void` | Unsubscribe |
| `events` | `{ SELECTION_CHANGED, CATALOG_CHANGED }` | Event names |
| `roles` | `{}` | Reserved, currently unused |

### EntryRef

A reference to a model:

```js
{ kind: 'st', provider: 'anthropic', model: 'claude-opus-5-5' }
```

| `kind` | Meaning |
|---|---|
| `st` | Called through a SillyTavern native source (the Native and Translated badges) |
| `omp` | Called through the OMTP gateway |
| `profile` | A SillyTavern connection profile; `model` is the profile name |

Its string form is `kind/provider/model`, such as `st/anthropic/claude-opus-5-5`. The `kind` of a model changes with its connection path, so compare references by `provider` and `model`.

### switchTo

```js
// Switch and save as the default (same as /model)
await OMTP.switchTo('anthropic/claude-opus-5-5:high');

// Switch for this session only (same as /switch)
await OMTP.switchTo('@1', { persist: false });

// An EntryRef, or its string form
await OMTP.switchTo({ kind: 'omp', provider: 'mock', model: 'echo' });
await OMTP.switchTo('omp/mock/echo');
```

- The argument may be a [selector](#selector-grammar), an EntryRef, an object with a `ref` field, or a `kind/provider/model` string.
- Returns the EntryRef that was used. When a selector matched several models fuzzily, the result carries a `warning` naming the one chosen.
- Throws when the model is unknown or unavailable (missing credentials, gateway not running, provider unsupported).

### Events

```js
const off = OMTP.on(OMTP.events.SELECTION_CHANGED, ({ ref, entry, gateway, reason }) => {
    console.log(`${ref.provider}/${ref.model}`, gateway ? 'via gateway' : 'native', reason);
});
// when no longer needed
off();
```

| Event | Name | Payload |
|---|---|---|
| `SELECTION_CHANGED` | `omtp:selection-changed` | `{ ref, entry, gateway, reason }`. `gateway` tells whether the gateway is used; `reason` names the trigger (such as `public-api`) |
| `CATALOG_CHANGED` | `omtp:catalog-changed` | `{ source }`, such as `runtime` or `adapter` |

Events are dispatched through SillyTavern's `eventSource`. By the time `SELECTION_CHANGED` fires, the reasoning effort has already been written to SillyTavern's settings.

### registerCatalogProvider

Accepts a single provider, a provider map or a whole catalog and merges it into the active catalog by provider id: new field values win, models merge by `id`. The merge only lives in the current page and is gone after a reload.

```js
OMTP.registerCatalogProvider({
    id: 'my-provider',
    label: 'My Provider',
    models: [{ id: 'my-model', name: 'My Model', kind: 'chat' }],
});
```

For the gateway to forward a new provider, add it under **Sign-in → Add custom provider** or call `POST /providers/:id/config`; `registerCatalogProvider` only affects the client's model list.

### registerProviderAdapter

Registers an object describing a SillyTavern native source; it needs a unique `key`. Its fields match the parameters of `createAdapter` in `src/adapters/native.js` (`label`, `mainApi`, `source`, `modelControl`, `modelField`, `supportsModel` and so on). Registration fires `CATALOG_CHANGED`.

## Selector grammar

Selectors are used by `OMTP.switchTo()`, `/model` and `/switch`. The panel's search box only filters by keyword and does not parse selectors.

| Form | Rule | Example |
|---|---|---|
| `provider/model` | Split at the first `/`; the first part must be a known provider id (case-insensitive), otherwise the whole string is treated as a keyword. The model id may contain further `/` | `anthropic/claude-opus-5-5`, `openrouter/deepseek/deepseek-v4.1-flash-1017` |
| `@1` … `@9` | Quick slot. An empty slot or unavailable model is an error | `@3` |
| `@fav`, `@favorites` | First usable favorite | `@fav` |
| `@recent`, `@recents` | First usable recent model | `@recent` |
| `:level` suffix | Reasoning effort: `auto`, `min`, `low`, `medium`, `high`, `max`. Not split off when the whole string is itself a model id containing a colon | `@1:medium` |
| Anything else | First an exact entry key or model id; otherwise a fuzzy match ranked as: exact `provider/model` → exact model id → favorites → recents → other substring matches | `gemini-4-argon` |

With several fuzzy matches the first one is used and the result's `warning` says so.

## Calling the plugin API from scripts

The full route list is in the [server plugin reference](./gateway.en.md#management-api). From code running in the SillyTavern page, add `x-omtp-client` to SillyTavern's request headers:

```js
const { getRequestHeaders } = SillyTavern.getContext();

const res = await fetch('/api/plugins/omtp/providers', {
    headers: { ...getRequestHeaders(), 'x-omtp-client': 'omtp-web' },
});
const { providers } = await res.json();
```

Without that header the plugin answers 403 `untrusted_client`.

The gateway sends no CORS headers, so browser pages cannot call it directly; code in the page should use the gateway through SillyTavern's Custom OpenAI connection. Other programs on the same machine pass the gateway token (file `data/omtp/gateway-token`, or `GET /api/plugins/omtp/gateway/token`):

```bash
TOKEN=$(cat SillyTavern/data/omtp/gateway-token)
curl -s http://127.0.0.1:4100/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"model":"mock/echo","messages":[{"role":"user","content":"ping"}]}'
```

The gateway's actual port is the one reported by `GET /api/plugins/omtp/status`.
