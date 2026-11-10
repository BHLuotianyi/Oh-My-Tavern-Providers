English | [简体中文](./testing.md) | [Back to README](../README.en.md)

# Testing

## Automated checks

```bash
npm test           # unit tests (node --test, runs tests/unit/*.test.mjs)
npm run validate   # catalog validation
```

- Unit tests use Node built-ins only; nothing needs to be installed. CI runs them on Node 18, 20 and 22 (`.github/workflows/checks.yml`).
- One file only: `node --test tests/unit/proxy-fetch.test.mjs`.
- `npm run validate` checks the structure of both catalogs (`catalog/` and `server-plugin/catalog/`), the native adapter mapping, and that the two files are identical.
- `node --check <file>` syntax-checks a changed `.js` / `.mjs` file.

The rules for writing tests are in [Contributing](../CONTRIBUTING.en.md#tests).

## Local mock provider

`tests/fixtures/mock-openai.mjs` is an OpenAI-compatible mock upstream for exercising the gateway without spending quota:

```bash
npm run mock        # listens on http://127.0.0.1:4199/v1; set PORT to change it
```

It serves one model, `echo`: a message containing `ping` gets `pong`, anything else gets `echo: <message>`. Streaming is supported and the last streamed chunk carries `usage`.

To use it in OMTP, open the panel's **Sign-in** tab, click **Add custom provider** and enter:

| Field | Value |
|---|---|
| ID | `mock` |
| Label | `Mock` |
| Adapter | `openai` |
| Base URL | `http://127.0.0.1:4199/v1` |
| Models | `echo` |
| Key | any non-empty value |

Then pick `mock/echo` on the **All** tab.

## Manual end-to-end checks

Use these to verify a change in a real SillyTavern. Prerequisites:

- the client extension is installed at `public/scripts/extensions/third-party/omtp-model-hub/`;
- the server plugin is installed at `plugins/omtp/` with `enableServerPlugins: true`;
- the mock provider is running and added as `mock` as described above.

### Browser

1. Load SillyTavern: `#main-API-selector-block` is hidden and `#omtp-hub-button` exists.
2. Open the panel, search `claude`, select a model that exists in a native control and use it. `#main_api`, `#chat_completion_source` and the model control match, and survive a reload.
3. Disable the extension and reload: the native selector returns and the last native selection still works.
4. Re-enable it and select `mock/echo` (OMTP badge): `custom_url` is `http://127.0.0.1:4100/v1`, `custom_model` is `mock/echo`, and the bearer header is set.
5. Send `ping`; the reply is `pong`.
6. Toggle **Hide native API selector** off and on; the state survives a reload.
7. Favorite a model, put it in a quick slot, switch with `Alt+1`.
8. Bind a model to a chat and switch chats; the binding applies. Bind a character as well and confirm the chat binding wins.
9. Set reasoning effort `high`: `#openai_reasoning_effort` and the request body both carry it.
10. Set the extra body `{"top_k":42}`; the mock receives the field. Then try `{"model":"x"}`; the protected key is rejected or removed.
11. Open `#API-status-top`: native keys, provider blocks, Connect buttons, connection profiles, `/api` and `/model` still work.
12. Refresh the catalog from a local file URL and from an invalid URL: the first succeeds, the second fails and keeps the old catalog.
13. Disable the extension while in gateway mode: Custom OpenAI returns to its settings from before gateway mode.

### Gateway

```bash
curl -s http://127.0.0.1:4100/health
TOKEN=$(cat SillyTavern/data/omtp/gateway-token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4100/v1/models
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"model":"mock/echo","messages":[{"role":"user","content":"ping"}],"stream":false}' \
  http://127.0.0.1:4100/v1/chat/completions
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4100/v1/models   # no token: expect 401
```

`gateway-token` is in `<SillyTavern data directory>/omtp/`; adjust the path if the data directory is not the default `data/`.
