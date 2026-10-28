# OMTP end-to-end checks

Prerequisites:

- SillyTavern 1.19.0 running at `http://127.0.0.1:8001/`.
- Client extension installed at
  `public/scripts/extensions/third-party/omtp-model-hub/`.
- Server plugin installed at `plugins/omtp/` and `enableServerPlugins: true`.
- Mock provider running: `node tests/fixtures/mock-openai.mjs` (port 4199).

Configure a custom provider from the hub's **Sign-in** tab (**Add custom provider**):

- id: `mock`
- label: `Mock`
- adapter: `openai`
- base URL: `http://127.0.0.1:4199/v1`
- model: `echo`
- key: any non-empty value

Browser checks:

1. Load SillyTavern. `#main-API-selector-block` is hidden and
   `#omtp-hub-button` exists.
2. Open the hub; search `claude`; select a model present in a native control and
   use it. Verify `#main_api`, `#chat_completion_source`, and the model control
   match, and settings survive reload.
3. Disable the extension and reload. Verify the native selector returns and the
   last native selection remains usable.
4. Re-enable the extension, select `mock/echo` in the hub (gateway entries carry
   the `OMTP` badge), and verify `custom_url=http://127.0.0.1:4100/v1`,
   `custom_model=mock/echo`, and the bearer header is set.
5. Send `ping`; the mock returns `pong`.
6. Toggle **Hide native API selector** off/on; verify visibility survives reload.
7. Favorite an entry, assign a quick slot, and switch with `Alt+1`.
8. Bind a model to a chat, switch chats, and verify the binding applies. Bind a
   character and verify a chat binding wins.
9. Set reasoning effort `high`; verify `#openai_reasoning_effort` and the request
   body contain it.
10. Add extra body `{"top_k":42}`; verify it reaches the mock request. Try
    `{"model":"x"}` and verify the protected key is rejected/removed.
11. Open `#API-status-top`; verify native keys, provider blocks, Connect buttons,
    Connection Profiles, and `/api` / `/model` still work.
12. Refresh the catalog from a local fixture URL and from an invalid URL; verify
    success and old-catalog retention.
13. Disable the extension while in gateway mode; verify the pre-gateway custom
    state is restored.

Gateway checks:

```bash
curl -s http://127.0.0.1:4100/health
TOKEN=$(cat <DATA_ROOT>/default-user/omtp/gateway-token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4100/v1/models
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"model":"mock/echo","messages":[{"role":"user","content":"ping"}],"stream":false}' \
  http://127.0.0.1:4100/v1/chat/completions
```

The token path may be `<DATA_ROOT>/omtp/gateway-token` when the server plugin
uses the default user directories for the gateway.
