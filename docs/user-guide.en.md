English | [简体中文](./user-guide.md) | [Back to README](../README.en.md)

# User guide

This guide covers the features of the OMTP panel. For installation see the [README](../README.en.md#installation).

## Opening the panel

- Hotkey `Alt+M` (configurable, see [Settings](#settings))
- The OMTP button in the top bar
- The OMTP button on the welcome screen
- The `/omtp` slash command

Keys inside the panel: `↑` / `↓` move the selection, `Enter` uses the selected model, `F` toggles a favorite, `Esc` closes the panel. While a text field has focus, keys go to the field.

## Layout

Providers are listed on the left, models in the middle, and the selected model's details on the right. Tabs along the top:

| Tab | Contents |
|---|---|
| All | Every provider and model |
| Favorites | Favorited models |
| Recent | Recently used models |
| Profiles | SillyTavern connection profiles (needs SillyTavern's built-in Connection Manager extension) |
| Sign-in | API keys, OAuth sign-in, custom providers |
| Usage | Provider quotas and token statistics |
| About | Extension and plugin versions, data sources |

Filters above the list:

- **Show non-mainstream providers**: uncheck to keep only first-party labs, major platforms and local runtimes.
- **Translated provider names**: show official Chinese names where they exist.
- **Only models with scores**: only models that have AA-PersonalityBench data.

The bottom-left corner shows the version and update status; see [Update check](#update-check).

On narrow screens (760px wide or less, such as a phone in portrait) the panel fills the screen: providers form one horizontally scrolling row, tapping a model opens its details over the list, and **Back to list** returns. The search box is not focused on open, so the keyboard stays down.

## Connection paths

Each model carries a badge that tells how OMTP makes SillyTavern call it:

| Badge | Meaning | Needs the server plugin |
|---|---|---|
| Native | SillyTavern supports the provider and accepts the model id. OMTP writes SillyTavern's own settings | No |
| Translated | A catalog alias or regional endpoint (e.g. `minimax-cn`) mapped to one of SillyTavern's native sources, also written directly | No |
| OMTP | SillyTavern cannot call it; requests go through the local gateway | Yes |
| Profile | A SillyTavern connection profile; applying it switches the whole set of connection settings | No |

When you use a model with the OMTP badge, OMTP:

1. records the current settings of the Custom OpenAI source;
2. sets the chat completion source to Custom, the URL to the gateway (`http://127.0.0.1:4100/v1` by default), the model to `provider/model`, and adds the gateway token.

Switching back to a native model, or disabling the extension, restores the settings recorded in step 1.

Native selections are SillyTavern's own settings and keep working after OMTP is removed.

## Sign-in and keys

On the **Sign-in** tab:

- **API key**: enter it and save. Saved keys are shown masked. A key the provider rejected is flagged and shows its last four characters.
- **OAuth authorization code**: sign-in opens the provider's page in a new tab; when the browser returns to the local loopback address, sign-in completes on its own. If the browser cannot reach that address (remote setup, a browser proxy that does not bypass localhost, a container without the callback port published), paste the URL from the address bar after authorizing back into the panel.
- **Device code**: the panel shows a code and a verification URL; complete it on any device.
- **Sign out**: removes the credentials OMTP saved for that provider.

OMTP looks for credentials in this order: credentials saved by OMTP → keys saved in SillyTavern → environment variables (such as `OPENAI_API_KEY`). Keys you already entered in SillyTavern do not need to be entered again.

Some providers (such as opencode) have a **Disguise User-Agent as the opencode client** switch on their row, on by default. When it is off, the gateway forwards SillyTavern's own User-Agent.

Volcengine Ark Coding Plan and Agent Plan have a **Send only max_tokens** switch on their row, on by default: when a request carries both `max_tokens` and `max_completion_tokens` (MVU's extra-model parsing does), the gateway drops `max_completion_tokens`, which Ark otherwise rejects with a 400.

> [!WARNING]
> Volcengine only allows these plans in AI coding / agent tools. Using a plan's Base URL and API key from SillyTavern may be treated as abuse and get the subscription suspended or the account banned.

### Custom providers

**Add custom provider** at the bottom of the **Sign-in** tab connects any endpoint that speaks a supported protocol, OpenAI-compatible or otherwise: enter an id, label, adapter, base URL, model list and key. Custom providers appear in the panel and in the gateway's model list.

### Live model lists

The refresh button next to a provider calls its model listing endpoint; models found that way carry a **live** badge. A list stays valid for 5 minutes. If fetching fails, the panel shows the error and falls back to the bundled catalog models instead of keeping the old list. Changing a key or signing out clears the provider's live list.

## Favorites, recents and quick slots

- Star a model in the details, or press `F` in the list, to favorite it.
- Models you use are added to **Recent** automatically.
- There are nine quick slots at the top of the panel:
  - Click **Save to quick bar** in the details, then a slot; or press `Alt+Shift+digit` to put the model in use into that slot.
  - Right-click a slot (long-press on touch screens) to clear it.
  - Press `Alt+1` … `Alt+9` anywhere in SillyTavern to switch to a slot's model.

## Bindings

In the details, click:

- **Bind chat**: stored in the chat's metadata and saved with the chat.
- **Bind character**: stored in the OMTP settings.

When a chat opens, OMTP checks the chat binding first and the character binding second; a chat binding wins when both exist. A binding also restores the reasoning effort recorded with it. **Auto-apply chat/character bindings** in the settings turns this off; character bindings are listed in the settings' **Bindings** section.

## Reasoning effort

Models that support reasoning offer an effort level in the details (`auto`, `min`, `low`, `medium`, `high`, `max`, limited to what the model supports). The level is remembered per model, restored when you switch back, and written to SillyTavern's reasoning effort setting (`openai_reasoning_effort`).

`/effort` does the same: without an argument it cycles through the available levels; with one it sets the level (a unique prefix such as `/effort hi` works). With no usable model selected, `/effort` sets SillyTavern's own reasoning effort.

## Extra request body

**Edit extra body** in the details attaches a JSON object to one model; it is merged into the request body on generation, for example:

```json
{ "top_k": 40 }
```

`model`, `messages`, `stream` and the API routing fields are managed by OMTP and cannot be overridden here; if present, they are reported and removed.

## Connection profiles

The **Profiles** tab manages SillyTavern Connection Manager profiles:

- create one from the current connection, or an empty one and fill it in field by field;
- duplicate, rename, delete;
- choose which settings a profile records (API, server URL, model, preset, secret, templates and so on);
- use a profile, stop using it (switch SillyTavern back to "None"), or update it from the current connection.

Profiles store connection settings only; chats, characters and prompts are untouched. Every change is reflected in SillyTavern's own profile dropdown.

## Usage and statistics

- **Usage** tab: for signed-in subscription providers it shows quota windows (such as 5-hour and weekly) as used percentages, reset times or account balance; above 70% the bar turns to a warning color, above 90% to an alert color. Quota data is cached for 60 seconds and can be refreshed by hand. Below it are token totals for this session and overall.
- **Token chip**: next to the OMTP button in the API drawer toolbar, showing the current chat's tokens and estimated cost; click it to open the usage page. Hidden on narrow screens; the usage page has the same numbers.
- **Statistics page**: `/omtp stats` starts a local page (port 3847 by default) and opens it in a new tab, with daily usage and cost by model and by chat. It listens on the local machine only and shuts down after 30 minutes without visits.

Statistics only cover requests that pass through the gateway. Costs are estimates from catalog prices: output tokens include reasoning tokens; without a cache price, cache reads and writes are charged at the input price; models discovered live without a catalog price use the provider's default model price (or the median of its priced models).

## Slash commands

| Command | Effect |
|---|---|
| `/omtp` | Open the panel |
| `/omtp stats` | Start and open the statistics page |
| `/model [selector]` | Switch the model and save it as the default. Without an argument, opens the panel |
| `/switch [selector]` | Switch for this session only, leaving the default alone. Without an argument, opens a keyboard quick picker |
| `/effort [level]` | Set or cycle the reasoning effort |
| `/usage` | Open the panel on the usage page |

`/model` replaces SillyTavern's command of the same name and accepts `--quiet` so that existing scripts keep working.

Common selector forms:

| Form | Meaning |
|---|---|
| `anthropic/claude-opus-5-5` | provider/model id, split at the first `/` |
| `claude-opus` | model id or keyword, matched fuzzily |
| `@1` … `@9` | quick slot |
| `@fav`, `@recent` | first usable favorite / recent model |
| `…:high` | reasoning effort suffix |

The full grammar is in the [developer API](./developer.en.md#selector-grammar).

## Settings

Find **OMTP Model Hub** in SillyTavern's **Extensions** settings:

| Section | Setting | Notes |
|---|---|---|
| Companion (TauriTavern only) | Address, token, Connect | The address and token `server-plugin/standalone.mjs` prints at startup; see the [README](../README.en.md#tauritavern) |
| Gateway | Gateway URL | Address the client uses for the gateway, `http://127.0.0.1:4100/v1` by default |
| | Start gateway with SillyTavern | When off, the gateway does not start automatically |
| | Require gateway token | Turning it off asks for confirmation. Without a token the gateway only accepts requests whose Host is a loopback address |
| | Restart gateway | |
| Network proxy | Outbound proxy | The proxy the server uses for sign-in, key checks, quota and gateway requests: the system proxy (default), a manual address, or none. The line below shows the proxy actually in effect |
| | Test connection | Reaches a few sign-in hosts through the proxy and directly, and says what the result means. Start here when sign-in reports "request failed / fetch failed" |
| Catalog | Refresh catalog | Fetches the catalog from the default or a given URL. Only model lists, names, prices and similar data are updated |
| | Import from local OMP | Reads the catalog in `~/oh-my-pi` or `~/.omp` as an overlay; optionally imports the keys and OAuth sessions OMP saved |
| Interface | Hide native API selector | On by default. It is only hidden; nothing is removed |
| | Hub hotkey | For example `alt+m`. `Alt+1` … `Alt+9` are reserved for quick slots |
| | Auto-apply chat/character bindings | |
| Update check | Channel | Nightly or Git (main) |
| Bindings | | Lists existing character bindings |
| Maintenance | Restore native selection | Returns to the SillyTavern model selection that was active before OMTP was used |
| | Clear OMTP settings | Clears favorites, recents, quick slots, bindings, extra bodies and UI preferences; with **Also delete provider keys** checked, stored keys are deleted too |

## Update check

The bottom-left corner shows the version and update status. OMTP reads the selected channel's `manifest.json` on GitHub and compares version numbers:

| Status | Meaning |
|---|---|
| Update available | The channel publishes a higher version |
| Up to date | Versions match |
| Local build is newer | This build is ahead of the channel |
| Update check failed | GitHub is unreachable; click to retry |

Clicking the status opens the commit list of the channel's branch. Results are cached for 10 minutes. Nightly builds follow the `nightly` channel by default, all others follow `main`; the settings can switch between them.

## FAQ

**A model shows as unavailable or its button is greyed out.** The details state the reason. Common ones:

- No credentials: enter a key or sign in on the **Sign-in** tab.
- The server plugin is not installed: models with the OMTP badge need the gateway.
- The provider only supports a proprietary client protocol (such as Cursor or GitHub Copilot chat), which the gateway cannot forward. These providers stay listed with the reason.

**SillyTavern's own API selector is gone.** OMTP hides it by default. Click **Show native API selector** at the top of the API drawer, or turn off **Hide native API selector** in the settings.

**There are no image, speech or embedding models.** The catalog keeps chat models only.

**The gateway status is not green.** Check that `plugins/omtp` exists, `enableServerPlugins: true` is set in `config.yaml`, and SillyTavern was restarted. If port 4100 is taken the gateway tries 4101 … 4110; if the port belongs to another OMTP gateway, that one is reused.

**OAuth sign-in stays pending.** The browser could not reach the local callback address. Paste the full URL from the address bar after authorizing into the panel and submit it.

**On SillyTavern 1.12.7 – 1.16.x, Custom OpenAI still points at the gateway after removal.** These versions do not support extension lifecycle hooks; OMTP polls for being disabled and restores the settings then. If the extension files are deleted directly, no code is left to restore anything, so change the Custom OpenAI URL back by hand. Disable the extension before removing it.
