/**
 * OMTP Model Hub — selection switch engine.
 *
 * Owns every write to SillyTavern's native API/model selection layer. The hub UI,
 * bindings and the public API all go through `switchToEntry`, which serializes
 * switches with `withSwitchLock` and refuses to run while a generation is active.
 *
 * Native switches write ST's own settings, so the selection survives plugin
 * removal. Gateway switches point ST's `custom` chat source at the OMTP Gateway;
 * the previous custom state is saved in `settings.gateway.savedCustom` and
 * restored when the selection leaves gateway mode or the extension is cleaned up.
 */

import { getSettings, saveSettings, getEntryKey, parseEntryKey } from './store.js';
import { codedError } from './errors.js';
import { resolveEntry } from './catalog.js';
import { API_BASE, EVENTS, MAX_RECENTS, PROFILE_PROVIDER_ID, REASONING_LEVELS } from './constants.js';
import { currentChatId } from './usage-session.js';
import { NATIVE_ADAPTERS } from './adapters/native.js';
import {
  main_api,
  online_status,
  isGenerating,
  saveSettingsDebounced,
  getRequestHeaders,
} from '../../../../../script.js';
import { eventSource } from '../../../../events.js';
import { oai_settings } from '../../../../openai.js';
import { textgenerationwebui_settings } from '../../../../textgen-settings.js';
import { nai_settings } from '../../../../nai-settings.js';
import { yaml } from '../../../../../lib.js';
import { SlashCommandParser } from '../../../../slash-commands/SlashCommandParser.js';
import { extension_settings } from '../../../../extensions.js';

const SWITCH_TIMEOUT_MS = 8000;
const STATUS_TIMEOUT_MS = 8000;
const POLL_INTERVAL_MS = 100;
const PROFILE_TIMEOUT_MS = 20000;
const GATEWAY_STATUS_TTL_MS = 5000;
const GATEWAY_TOKEN_TTL_MS = 60000;

/** [snapshot key, oai_settings field, DOM control] */
const CUSTOM_FIELDS = [
  ['customUrl', 'custom_url', '#custom_api_url_text'],
  ['customModel', 'custom_model', '#custom_model_id'],
  ['customIncludeHeaders', 'custom_include_headers', '#custom_include_headers'],
  ['customIncludeBody', 'custom_include_body', '#custom_include_body'],
  ['customExcludeBody', 'custom_exclude_body', '#custom_exclude_body'],
  ['customPromptPostProcessing', 'custom_prompt_post_processing', '#custom_prompt_post_processing'],
];

const SETTINGS_ROOTS = {
  openai: () => oai_settings,
  textgenerationwebui: () => textgenerationwebui_settings,
  novel: () => nai_settings,
};

/** Serializes switches so a second request waits for the first one. */
let switchChain = Promise.resolve();
/** Gateway URL last reported by the server plugin; used for synchronous mode checks. */
let activeGatewayUrl = null;
let gatewayStatusCache = { at: 0, value: null };
let gatewayTokenCache = { at: 0, url: null, token: null };
let providerStatusCache = { at: 0, value: null };

/**
 * Fetch provider availability from the server plugin. Never throws; returns
 * null when the plugin is unavailable so native routing still works.
 */
async function getProviderStatuses() {
  if (Date.now() - providerStatusCache.at < GATEWAY_STATUS_TTL_MS && providerStatusCache.value) {
    return providerStatusCache.value;
  }
  try {
    const response = await fetch(`${API_BASE}/providers`, { headers: getRequestHeaders({ omitContentType: true }) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const list = Array.isArray(data?.providers) ? data.providers : [];
    const map = new Map(list.map(provider => [String(provider.id), provider]));
    providerStatusCache = { at: Date.now(), value: map };
    return map;
  } catch {
    return null;
  }
}

// MARK: helpers

function normalizeUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

function jq(selector) {
  if (typeof $ !== 'function') {
    return null;
  }
  try {
    const element = $(selector);
    return element.length ? element : null;
  } catch {
    return null;
  }
}

/**
 * Set a control and fire the event ST listens to.
 * Selects whose option is missing are left untouched (their change handler would
 * otherwise clobber the settings field with the current selection).
 */
function setControlValue(selector, value, eventName = null) {
  if (value == null) {
    return false;
  }
  const element = jq(selector);
  if (!element) {
    return false;
  }
  element.val(value);
  if (element.is('select') && String(element.val()) !== String(value)) {
    return false;
  }
  const event = eventName ?? (element.is('input, textarea') ? 'input' : 'change');
  element.trigger(event);
  return true;
}

function readSettingField(api, field) {
  if (!field) {
    return undefined;
  }
  const root = SETTINGS_ROOTS[api];
  if (!root) {
    return undefined;
  }
  let node = root();
  const path = String(field).replace(/^nai_settings\./, '').split('.').filter(Boolean);
  for (const part of path) {
    if (node == null) {
      return undefined;
    }
    node = node[part];
  }
  return node;
}

function writeSettingField(api, field, value) {
  if (!field) {
    return;
  }
  const root = SETTINGS_ROOTS[api];
  if (!root) {
    return;
  }
  const path = String(field).replace(/^nai_settings\./, '').split('.').filter(Boolean);
  if (!path.length) {
    return;
  }
  let node = root();
  for (let i = 0; i < path.length - 1; i++) {
    if (node[path[i]] == null || typeof node[path[i]] !== 'object') {
      node[path[i]] = {};
    }
    node = node[path[i]];
  }
  node[path[path.length - 1]] = value;
}

function adapterForState(api, source, type) {
  if (!api) {
    return null;
  }
  let suffix = null;
  if (api === 'openai') {
    suffix = source;
  } else if (api === 'textgenerationwebui') {
    suffix = type;
  }
  return NATIVE_ADAPTERS[`${api}:${suffix ?? '-'}`] ?? null;
}

function currentAdapter() {
  return adapterForState(main_api, oai_settings?.chat_completion_source, textgenerationwebui_settings?.type);
}

function currentModel() {
  const adapter = currentAdapter();
  if (!adapter) {
    return '';
  }
  if (typeof adapter.getModel === 'function') {
    try {
      return String(adapter.getModel() ?? '');
    } catch {
      return '';
    }
  }
  const value = readSettingField(adapter.mainApi, adapter.modelField);
  return value == null ? '' : String(value);
}

function gatewaySettings(settings) {
  if (!settings.gateway || typeof settings.gateway !== 'object') {
    settings.gateway = { savedCustom: null };
  }
  return settings.gateway;
}

function refOf(entry) {
  if (!entry) {
    return null;
  }
  if (entry.ref && entry.ref.kind && entry.ref.provider) {
    return { kind: entry.ref.kind, provider: entry.ref.provider, model: String(entry.ref.model ?? '') };
  }
  if (entry.kind && entry.provider) {
    return { kind: entry.kind, provider: entry.provider, model: String(entry.model ?? '') };
  }
  return null;
}

function normalizeRef(ref) {
  if (!ref) {
    return null;
  }
  if (typeof ref === 'string') {
    try {
      return normalizeRef(parseEntryKey(ref));
    } catch {
      return null;
    }
  }
  if (typeof ref !== 'object') {
    return null;
  }
  if (!ref.kind || !ref.provider) {
    // Same `{ key }` shape the public API accepts.
    return typeof ref.key === 'string' ? normalizeRef(parseEntryKey(ref.key)) : null;
  }
  return { kind: ref.kind, provider: ref.provider, model: String(ref.model ?? '') };
}

function isEntryRef(value) {
  return !!value && typeof value === 'object' && typeof value.kind === 'string' && typeof value.provider === 'string';
}

/**
 * Is the selected Connection Profile still the live connection?
 *
 * SillyTavern keeps `selectedProfile` after the user edits the API settings by
 * hand, so the dropdown alone is not proof. A profile stores the model it
 * applied; when the live model no longer matches, the profile is stale and the
 * marker must fall back to native detection.
 * @param {any} profile
 * @returns {boolean}
 */
function profileStillApplied(profile) {
  const model = String(profile?.model ?? '');
  if (model && model !== String(currentModel() ?? '')) {
    return false;
  }
  return true;
}

/**
 * SillyTavern's profile dropdown is authoritative: a profile picked there is
 * the active connection even when OMTP never applied it.
 * @returns {{kind:'profile', provider:string, model:string}|null}
 */
function detectCurrentProfile() {
  try {
    const manager = extension_settings?.connectionManager;
    const selectedId = String(manager?.selectedProfile || '');
    if (!selectedId) {
      return null;
    }
    const profiles = Array.isArray(manager.profiles) ? manager.profiles : [];
    const profile = profiles.find((item) => item?.id === selectedId);
    if (!profile || !profileStillApplied(profile)) {
      return null;
    }
    return { kind: 'profile', provider: PROFILE_PROVIDER_ID, model: selectedId };
  } catch {
    return null;
  }
}

function detectCurrentRef() {
  const settings = getSettings();
  const last = settings.lastSelection;

  if (isGatewayMode()) {
    const customModel = String(oai_settings?.custom_model ?? '');
    const separator = customModel.indexOf('/');
    if (separator > 0) {
      return { kind: 'omp', provider: customModel.slice(0, separator), model: customModel.slice(separator + 1) };
    }
    return null;
  }

  // A Connection Profile is the active connection when SillyTavern still has
  // it selected; without this the hub forgets the profile the moment it is
  // applied and only ever marks native/gateway models as current.
  const profileRef = detectCurrentProfile();
  if (profileRef) {
    return profileRef;
  }

  const adapter = currentAdapter();
  const model = currentModel();
  if (!adapter || !model) {
    return null;
  }
  if (last && last.kind === 'st' && last.model === model) {
    const entry = resolveEntry(last);
    if (entry?.nativeAdapter?.key === adapter.key || last.provider === adapter.key) {
      return { kind: 'st', provider: entry?.provider || last.provider, model: last.model };
    }
  }
  const match = resolveEntry({ kind: 'st', provider: adapter.key, model });
  if (match) {
    return { kind: 'st', provider: match.provider, model };
  }
  return { kind: 'st', provider: adapter.key, model };
}

function recordSelection(entry, { native = false, persist = true } = {}) {
  const settings = getSettings();
  const ref = refOf(entry);
  if (!ref) {
    return;
  }
  if (persist) {
    settings.lastSelection = ref;
  }
  const recents = Array.isArray(settings.recents) ? settings.recents.filter(isEntryRef) : [];
  const key = getEntryKey(ref);
  settings.recents = [ref, ...recents.filter(recent => getEntryKey(recent) !== key)].slice(0, MAX_RECENTS);
  if (native) {
    settings.lastNativeSelection = captureSelection();
  }
}

function emitSelectionChanged(entry, { gateway = isGatewayMode(), reason = undefined } = {}) {
  const payload = { ref: refOf(entry), entry: entry ?? null, gateway, reason };
  try {
    Promise.resolve(eventSource.emit(EVENTS.SELECTION_CHANGED, payload)).catch(error => {
      console.debug('[omtp] selection-changed listener failed', error);
    });
  } catch (error) {
    console.debug('[omtp] selection-changed emit failed', error);
  }
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    Promise.resolve(promise).then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Apply a reasoning level to SillyTavern's own control, outside any model
 * selection. Used by `/effort` when nothing is connected yet.
 * @param {string} level
 */
export function applyGlobalReasoning(level) {
  const target = String(level || '').trim().toLowerCase();
  if (!REASONING_LEVELS.includes(target)) {
    throw codedError('reasoning_level', [level], `Unknown reasoning level: ${level}`);
  }
  if (main_api !== 'openai') {
    return { applied: false, level: target };
  }
  setReasoningValue(target);
  saveSettingsDebounced();
  return { applied: true, level: target };
}

function setReasoningValue(level) {
  if (!level) {
    return;
  }
  oai_settings.reasoning_effort = level;
  const element = jq('#openai_reasoning_effort');
  if (!element) {
    return;
  }
  element.val(level);
  if (String(element.val()) === level) {
    element.trigger('input');
  }
}

function writeCustomFields(snapshot) {
  if (!snapshot) {
    return;
  }
  for (const [key, field, selector] of CUSTOM_FIELDS) {
    const value = snapshot[key];
    if (typeof value !== 'string') {
      continue;
    }
    oai_settings[field] = value;
    setControlValue(selector, value);
  }
}

/** Header carrying the SillyTavern chat id, so usage can be attributed per chat. */
const CHAT_HEADER = 'X-OMTP-Chat';

/**
 * HTTP header values are Latin-1 only: a chat named in Chinese or with an emoji
 * made SillyTavern throw `Invalid Character in header content ["X-OMTP-Chat"]`
 * before the request was ever sent. Percent-encoding keeps it ASCII; the
 * gateway decodes it again.
 * @param {string} [chatId]
 * @returns {string}
 */
function encodeChatId(chatId) {
  const text = String(chatId || '');
  if (!text) {
    return '';
  }
  try {
    return encodeURIComponent(text);
  } catch {
    return '';
  }
}

/**
 * Keep the `X-OMTP-Chat` header in sync with the open chat. Called on
 * CHAT_CHANGED while in gateway mode; a no-op for native providers.
 * @param {string} [chatId]
 */
export function syncChatHeader(chatId = currentChatId()) {
  if (!isGatewayMode()) {
    return false;
  }
  // Drop the header entirely when no chat is open, so we never send a blank id.
  const text = String(oai_settings.custom_include_headers || '').trim();
  let parsed = {};
  if (text) {
    try {
      const value = yaml.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        parsed = { ...value };
      }
    } catch {
      parsed = {};
    }
  }
  if (chatId) {
    parsed[CHAT_HEADER] = encodeChatId(chatId);
  } else {
    delete parsed[CHAT_HEADER];
  }
  const merged = String(yaml.stringify(parsed) ?? '').trimEnd();
  if (merged === String(oai_settings.custom_include_headers || '').trimEnd()) {
    return false;
  }
  oai_settings.custom_include_headers = merged;
  setControlValue('#custom_include_headers', merged);
  saveSettingsDebounced();
  return true;
}

function mergeYamlHeaders(existing, additions) {
  let parsed = null;
  const text = typeof existing === 'string' ? existing.trim() : '';
  if (text) {
    try {
      const value = yaml.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        parsed = value;
      }
    } catch {
      // Invalid YAML: replace with only the managed headers.
      parsed = null;
    }
  }
  const merged = { ...(parsed ?? {}) };
  for (const [key, value] of Object.entries(additions || {})) {
    if (value === undefined || value === null || value === '') {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return String(yaml.stringify(merged) ?? '').trimEnd();
}

// MARK: gateway status / token

async function fetchGatewayStatus() {
  const response = await fetch(`${API_BASE}/status`, { headers: getRequestHeaders() });
  if (!response.ok) {
    throw new Error(`status request failed (${response.status})`);
  }
  const data = await response.json();
  const gateway = data?.gateway ?? {};
  const url = normalizeUrl(gateway.url);
  if (url) {
    activeGatewayUrl = url;
  }
  return {
    running: !!gateway.running,
    url: url || null,
    port: gateway.port ?? null,
    requireAuth: !!gateway.requireAuth,
    lastError: gateway.lastError ?? null,
    serverPlugin: data?.serverPlugin === true,
  };
}

/**
 * Current gateway status. Never throws: without the server plugin it degrades to
 * `running:false` with the manually configured URL.
 */
export async function getGatewayStatus({ force = false } = {}) {
  if (!force && gatewayStatusCache.value && Date.now() - gatewayStatusCache.at < GATEWAY_STATUS_TTL_MS) {
    return gatewayStatusCache.value;
  }
  let value;
  try {
    value = await fetchGatewayStatus();
  } catch (error) {
    value = {
      running: false,
      url: normalizeUrl(getSettings().gatewayUrl) || null,
      port: null,
      requireAuth: false,
      lastError: error?.message ?? 'status unavailable',
      serverPlugin: false,
    };
  }
  gatewayStatusCache = { at: Date.now(), value };
  return value;
}

async function resolveGatewayToken(status) {
  if (!status.requireAuth) {
    return null;
  }
  const settings = getSettings();
  const url = status.url || normalizeUrl(settings.gatewayUrl);
  if (gatewayTokenCache.token && gatewayTokenCache.url === url && Date.now() - gatewayTokenCache.at < GATEWAY_TOKEN_TTL_MS) {
    return gatewayTokenCache.token;
  }
  try {
    const response = await fetch(`${API_BASE}/gateway/token`, { headers: getRequestHeaders() });
    if (response.ok) {
      const data = await response.json();
      const token = typeof data?.token === 'string' ? data.token.trim() : '';
      if (token) {
        gatewayTokenCache = { at: Date.now(), url, token };
        return token;
      }
    }
  } catch (error) {
    console.debug('[omtp] gateway token request failed', error);
  }
  const manual = String(settings.gatewayToken ?? '').trim();
  return manual || null;
}

// MARK: primitives

/**
 * Poll `predicate` until it returns a truthy value.
 * @template T
 * @param {() => T} predicate
 * @returns {Promise<T>}
 */
function waitFor(predicate, timeoutMs = SWITCH_TIMEOUT_MS, intervalMs = POLL_INTERVAL_MS) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (error) {
        reject(error);
        return;
      }
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('Timed out waiting for condition'));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** Serialize switches; a second switch waits for the first one to settle. */
function withSwitchLock(fn) {
  const run = switchChain.then(() => fn());
  switchChain = run.then(() => undefined, () => undefined);
  return run;
}

function assertCanSwitch() {
  if (isGenerating()) {
    throw codedError('generating', [], 'Cannot switch while generating');
  }
}

export function isGatewayMode() {
  if (main_api !== 'openai') {
    return false;
  }
  if (oai_settings?.chat_completion_source !== 'custom') {
    return false;
  }
  const current = normalizeUrl(oai_settings?.custom_url);
  if (!current) {
    return false;
  }
  const settings = getSettings();
  // `activeUrl` is the URL actually written to `custom_url`; without it a reload
  // on a fallback port (the server plugin may bind 4100-4110) reported native.
  const candidates = [...new Set([
    activeGatewayUrl,
    settings?.gatewayUrl,
    settings?.gateway?.activeUrl,
  ].map(normalizeUrl).filter(Boolean))];
  return candidates.some(url => current === url || current.startsWith(`${url}/`));
}

// MARK: snapshots

/** Custom-source fields as stored in a selection snapshot. */
function captureCustomFields() {
  const fields = {};
  for (const [key, field] of CUSTOM_FIELDS) {
    fields[key] = oai_settings?.[field] ?? '';
  }
  return fields;
}

export function captureSelection() {
  return {
    ref: detectCurrentRef(),
    mainApi: main_api ?? '',
    chatCompletionSource: main_api === 'openai' ? (oai_settings?.chat_completion_source ?? null) : null,
    textgenType: main_api === 'textgenerationwebui' ? (textgenerationwebui_settings?.type ?? null) : null,
    model: currentModel(),
    reasoningEffort: oai_settings?.reasoning_effort ?? '',
    ...captureCustomFields(),
  };
}

/** Snapshot of ST's custom-source state, without a selection ref. */
function captureCustomState() {
  return { ...captureSelection(), ref: null };
}

/**
 * Restore a custom-source snapshot.
 * `fieldsOnly` writes only the custom URL/headers/body/model fields (used when
 * leaving gateway mode, where the API/source is set by the following switch).
 */
async function restoreCustomState(snapshot, { fast = false, fieldsOnly = false } = {}) {
  if (!snapshot || typeof snapshot !== 'object') {
    return false;
  }
  writeCustomFields(snapshot);
  if (fieldsOnly) {
    // This path skips restoreSelection(), which is where the full restore
    // writes the reasoning control.
    if (typeof snapshot.reasoningEffort === 'string' && snapshot.reasoningEffort) {
      setReasoningValue(snapshot.reasoningEffort);
    }
    saveSettingsDebounced();
    return true;
  }
  return restoreSelection({ ...snapshot, ref: null }, { fast });
}

/**
 * Restore a full selection snapshot. Never throws: missing DOM controls are
 * skipped so cleanup can run inside the extension hook timeout.
 */
export async function restoreSelection(snapshot, { fast = false } = {}) {
  if (!snapshot || typeof snapshot !== 'object') {
    return false;
  }

  writeCustomFields(snapshot);

  if (typeof snapshot.reasoningEffort === 'string' && snapshot.reasoningEffort) {
    setReasoningValue(snapshot.reasoningEffort);
  }

  if (snapshot.mainApi) {
    const changed = setControlValue('#main_api', snapshot.mainApi, 'change');
    if (changed && !fast) {
      await waitFor(() => main_api === snapshot.mainApi).catch(() => {});
    }
  }

  if (snapshot.mainApi === 'openai' && snapshot.chatCompletionSource) {
    const changed = setControlValue('#chat_completion_source', snapshot.chatCompletionSource, 'change');
    if (changed && !fast) {
      await waitFor(() => oai_settings.chat_completion_source === snapshot.chatCompletionSource).catch(() => {});
    }
  }

  if (snapshot.mainApi === 'textgenerationwebui' && snapshot.textgenType) {
    const changed = setControlValue('#textgen_type', snapshot.textgenType, 'change');
    if (changed && !fast) {
      await waitFor(() => textgenerationwebui_settings.type === snapshot.textgenType).catch(() => {});
    }
  }

  if (snapshot.model) {
    const adapter = adapterForState(snapshot.mainApi, snapshot.chatCompletionSource, snapshot.textgenType);
    if (adapter?.modelControl) {
      setControlValue(adapter.modelControl, snapshot.model);
    } else if (adapter?.modelField) {
      writeSettingField(adapter.mainApi, adapter.modelField, snapshot.model);
    }
  }

  saveSettingsDebounced();

  const settings = getSettings();
  const restoredIsGateway = isGatewayMode();
  if (snapshot.ref) {
    settings.lastSelection = snapshot.ref;
  }
  if (!restoredIsGateway) {
    gatewaySettings(settings).savedCustom = null;
    if (snapshot.ref && snapshot.ref.kind !== 'omp') {
      settings.lastNativeSelection = snapshot;
    }
  }
  saveSettings();

  emitSelectionChanged(snapshot.ref ? { ref: snapshot.ref } : null, { gateway: restoredIsGateway });
  return true;
}

// MARK: reasoning

/**
 * Apply a reasoning effort level. An explicit `level` wins and is remembered for
 * the entry; otherwise the stored per-entry level is used.
 */
export function applyReasoning(entry, level) {
  const settings = getSettings();
  const ref = refOf(entry);
  const key = ref ? getEntryKey(ref) : null;
  const requested = typeof level === 'string' ? level.trim().toLowerCase() : '';
  const stored = key ? String(settings.reasoningByEntry?.[key] ?? '').trim().toLowerCase() : '';
  let target = requested || stored;

  if (!target) {
    // Without a level for this model the previous model's effort would leak in.
    if (main_api !== 'openai') {
      return;
    }
    target = 'auto';
  }
  if (!REASONING_LEVELS.includes(target)) {
    console.debug('[omtp] ignoring unknown reasoning level', target);
    return;
  }
  if (key && requested) {
    settings.reasoningByEntry ??= {};
    settings.reasoningByEntry[key] = target;
  }
  if (main_api !== 'openai') {
    console.debug('[omtp] reasoning effort is only applied to the OpenAI-compatible API');
    return;
  }
  setReasoningValue(target);
  saveSettingsDebounced();
}

// MARK: switches

/**
 * Resolve the adapter for a native switch and reject entries the native UI
 * cannot drive.
 * @param {object} entry
 * @returns {object} the native adapter
 */
function requireNativeAdapter(entry) {
  if (entry?.available === false) {
    throw entry.unsupportedReason
      ? new Error(entry.unsupportedReason)
      : codedError('unavailable', [entry.model], `Model ${entry.model} is not available in SillyTavern`);
  }
  const adapter = entry?.nativeAdapter;
  if (!adapter) {
    throw codedError('no_native_adapter', [entry?.provider ?? 'unknown provider'], `No native SillyTavern adapter for ${entry?.provider ?? 'unknown provider'}`);
  }
  if (adapter.readOnlyReason) {
    throw new Error(adapter.readOnlyReason);
  }
  if (adapter.modelControl && typeof adapter.supportsModel === 'function' && !adapter.supportsModel(entry.model)) {
    throw codedError('model_unavailable', [entry.model, adapter.label || adapter.key], `Model ${entry.model} is not available in ${adapter.label || adapter.key}`);
  }
  if (!jq('#main_api')) {
    throw codedError('ui_not_ready', [], 'SillyTavern UI is not ready');
  }
  return adapter;
}

/**
 * Restore ST's own custom-source state when the previous selection came from
 * the gateway, so a native switch does not leave gateway fields behind.
 * The saved state is left in place: the caller clears it once the whole switch
 * has succeeded, so a failure can still restore the gateway selection.
 * @param {object} settings
 * @returns {Promise<boolean>} whether the gateway fields were replaced
 */
async function leaveGatewayMode(settings) {
  if (!gatewaySettings(settings).savedCustom) {
    return false;
  }
  // Resolve the live gateway port so isGatewayMode() is accurate after a reload.
  await getGatewayStatus();
  if (!isGatewayMode()) {
    return false;
  }
  await restoreCustomState(gatewaySettings(settings).savedCustom, { fast: true, fieldsOnly: true });
  return true;
}

/** Write ST's main API and wait for it to settle. */
async function selectNativeApi(adapter) {
  setControlValue('#main_api', adapter.mainApi, 'change');
  await waitFor(() => main_api === adapter.mainApi).catch(() => {
    throw codedError('api_switch', [adapter.mainApi], `Failed to switch the API to ${adapter.mainApi}`);
  });
}

/** Select the chat-completion source, textgen type or NovelAI model for the adapter. */
async function selectNativeSource(entry, adapter) {
  if (adapter.mainApi === 'openai' && adapter.source) {
    if (!setControlValue('#chat_completion_source', adapter.source, 'change')) {
      throw codedError('source_switch', [adapter.source], `Failed to select the chat completion source ${adapter.source}`);
    }
    await waitFor(() => oai_settings.chat_completion_source === adapter.source).catch(() => {
      throw codedError('source_switch', [adapter.source], `Failed to select the chat completion source ${adapter.source}`);
    });
    return;
  }

  if (adapter.mainApi === 'textgenerationwebui' && adapter.type) {
    if (!setControlValue('#textgen_type', adapter.type, 'change')) {
      throw codedError('textgen_switch', [adapter.type], `Failed to select the text generation type ${adapter.type}`);
    }
    await waitFor(() => textgenerationwebui_settings.type === adapter.type).catch(() => {
      throw codedError('textgen_switch', [adapter.type], `Failed to select the text generation type ${adapter.type}`);
    });
    return;
  }

  if (adapter.mainApi === 'novel') {
    if (!setControlValue('#model_novel_select', entry.model, 'change')) {
      throw codedError('model_unavailable', [entry.model, 'NovelAI'], `Model ${entry.model} is not available in NovelAI`);
    }
    await waitFor(() => nai_settings.model_novel === entry.model).catch(() => {
      throw codedError('novel_model', [entry.model], `Failed to select the NovelAI model ${entry.model}`);
    });
  }
}

/** Select the model in the adapter's control and wait for ST to store it. */
async function selectNativeModel(entry, adapter) {
  if (!jq(adapter.modelControl)) {
    throw codedError('control_missing', [adapter.modelControl], `Native model control not found: ${adapter.modelControl}`);
  }
  if (!setControlValue(adapter.modelControl, entry.model)) {
    throw codedError('model_unavailable', [entry.model, adapter.label || adapter.key], `Model ${entry.model} is not available in ${adapter.label || adapter.key}`);
  }
  await waitFor(() => String(readSettingField(adapter.mainApi, adapter.modelField) ?? '') === String(entry.model)).catch(() => {
    throw codedError('model_apply', [entry.model], `Failed to apply the model ${entry.model}`);
  });
}

/**
 * Click the adapter's connect button when ST reports no connection.
 * @param {object} adapter
 * @returns {Promise<boolean>} false when the connection did not come up
 */
async function ensureNativeConnection(adapter) {
  if (online_status !== 'no_connection' || !adapter.connectButton) {
    return true;
  }
  const button = jq(adapter.connectButton);
  if (!button) {
    return true;
  }
  button.trigger('click');
  try {
    await waitFor(() => online_status !== 'no_connection', STATUS_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

async function switchToNative(entry, { level, persist = true, reason } = {}) {
  const adapter = requireNativeAdapter(entry);
  const settings = getSettings();
  // Taken before leaving the gateway so a failed switch can put ST back on it.
  const previous = captureSelection();
  const previousWasGateway = isGatewayMode();
  const leftGateway = await leaveGatewayMode(settings);

  let connected = true;
  try {
    await selectNativeApi(adapter);
    await selectNativeSource(entry, adapter);

    if (!adapter.modelControl) {
      throw codedError('unsupported', [entry?.providerLabel || entry?.provider || ''], 'Read-only provider; manage it in the native UI');
    }
    if (adapter.mainApi !== 'novel') {
      await selectNativeModel(entry, adapter);
    }

    applyReasoning(entry, level);
    saveSettingsDebounced();
    connected = await ensureNativeConnection(adapter);
  } catch (error) {
    if (previousWasGateway || leftGateway) {
      await restoreSelection(previous, { fast: true }).catch(() => {});
    }
    throw error;
  }

  if (!connected) {
    await restoreSelection(previous, { fast: true }).catch(() => {});
    throw codedError('connect_failed', [adapter.label || adapter.key], `Connection failed for ${adapter.label || adapter.key}`);
  }

  // Only now is the native switch complete; the gateway snapshot is obsolete.
  gatewaySettings(settings).savedCustom = null;
  recordSelection(entry, { native: true, persist });
  saveSettings();
  emitSelectionChanged(entry, { reason });
  return entry;
}

/** Reject entries the gateway cannot drive. */
function requireGatewayEntry(entry) {
  if (!entry?.gatewayAdapter) {
    throw entry?.unsupportedReason
      ? new Error(entry.unsupportedReason)
      : codedError('unsupported', [entry?.providerLabel || entry?.provider || 'unknown'], `Provider ${entry?.providerLabel || entry?.provider || 'unknown'} is not supported`);
  }
  if (entry.available === false) {
    throw entry.unsupportedReason
      ? new Error(entry.unsupportedReason)
      : codedError('needs_key', [entry.providerLabel || entry.provider], `Provider ${entry.providerLabel || entry.provider} has no usable API key`);
  }
  if (!String(entry.model ?? '')) {
    throw codedError('gateway_model_id', [], 'Gateway model id is missing');
  }
}

/**
 * Resolve the gateway URL and token, refusing providers the gateway reports as
 * unusable.
 * @param {object} entry
 * @param {object} settings
 * @returns {Promise<{status: object, gatewayUrl: string, token: string|null}>}
 */
async function resolveGatewayTarget(entry, settings) {
  const status = await getGatewayStatus();
  if (!status.running) {
    throw status.lastError
    ? codedError('gateway_reason', [status.lastError], `OMTP Gateway unavailable: ${status.lastError}`)
    : codedError('gateway_off', [], 'OMTP Gateway unavailable (enable server plugins)');
  }
  const providerStatuses = await getProviderStatuses();
  const providerStatus = providerStatuses?.get(String(entry.provider));
  if (providerStatus && providerStatus.available === false) {
    const label = providerStatus.label || entry.provider;
    throw providerStatus.keyInvalidReason
      ? codedError('key_rejected', [label, providerStatus.keyInvalidReason], `Provider ${label} rejected its key (${providerStatus.keyInvalidReason})`)
      : codedError('needs_key', [label], `Provider ${label} needs an API key; configure it in OMTP settings`);
  }
  const gatewayUrl = status.url || normalizeUrl(settings.gatewayUrl);
  if (!gatewayUrl) {
    throw codedError('gateway_url', [], 'OMTP Gateway URL is not configured');
  }
  const token = await resolveGatewayToken({ ...status, url: gatewayUrl });
  if (status.requireAuth && !token) {
    throw codedError('gateway_token', [], 'OMTP Gateway token is unavailable');
  }
  return { status, gatewayUrl, token };
}

/**
 * Point ST's custom source at the gateway. URL, headers and model must be in
 * place before the source changes, because the source change immediately
 * validates the endpoint.
 */
function writeGatewayEndpoint(target, model) {
  // Remember the URL actually written; the server plugin may bind a fallback
  // port, so `settings.gatewayUrl` alone cannot identify gateway mode after a
  // reload.
  gatewaySettings(getSettings()).activeUrl = target.gatewayUrl;
  oai_settings.custom_url = target.gatewayUrl;
  setControlValue('#custom_api_url_text', target.gatewayUrl);

  const additions = {
    [CHAT_HEADER]: encodeChatId(currentChatId()) || undefined,
  };
  if (target.status.requireAuth && target.token) {
    additions.Authorization = `Bearer ${target.token}`;
  }
  const headers = mergeYamlHeaders(oai_settings.custom_include_headers, additions);
  oai_settings.custom_include_headers = headers;
  setControlValue('#custom_include_headers', headers);

  oai_settings.custom_model = model;
  setControlValue('#custom_model_id', model);
}

/** Switch the chat completion source to `custom` and wait for it to settle. */
async function selectCustomSource() {
  if (jq('#chat_completion_source')) {
    if (!setControlValue('#chat_completion_source', 'custom', 'change')) {
      throw codedError('custom_source', [], 'Failed to select the custom chat completion source');
    }
  } else {
    oai_settings.chat_completion_source = 'custom';
  }
  await waitFor(() => oai_settings.chat_completion_source === 'custom').catch(() => {
    throw codedError('custom_source', [], 'Failed to select the custom chat completion source');
  });
}

/**
 * Re-apply the gateway model: switching the source repopulates
 * `#model_custom_select` and rewrites `custom_model` from whatever that select
 * currently shows.
 */
async function applyGatewayModel(model) {
  const modelSelect = jq('#model_custom_select');
  const hasOption = modelSelect?.length
    ? modelSelect.find('option').filter((_, option) => option.value === model).length > 0
    : false;
  if (hasOption) {
    setControlValue('#model_custom_select', model, 'change');
  }
  oai_settings.custom_model = model;
  setControlValue('#custom_model_id', model);
  await waitFor(() => oai_settings.custom_model === model).catch(() => {
    throw codedError('gateway_model', [model], `Failed to set the gateway model ${model}`);
  });
}

async function switchToGateway(entry, { level, persist = true, reason } = {}) {
  const settings = getSettings();
  requireGatewayEntry(entry);
  const model = `${entry.provider}/${String(entry.model ?? '')}`;

  const target = await resolveGatewayTarget(entry, settings);
  if (!jq('#main_api')) {
    throw codedError('ui_not_ready', [], 'SillyTavern UI is not ready');
  }

  // Snapshot before touching ST: a half-applied gateway switch must roll back.
  const previous = captureSelection();
  const previousSavedCustom = gatewaySettings(settings).savedCustom;
  const previousActiveUrl = gatewaySettings(settings).activeUrl;

  try {
    if (!isGatewayMode()) {
      gatewaySettings(settings).savedCustom = captureCustomState();
    }

    setControlValue('#main_api', 'openai', 'change');
    await waitFor(() => main_api === 'openai').catch(() => {
      throw codedError('api_switch', ['openai'], 'Failed to switch the API to openai');
    });

    writeGatewayEndpoint(target, model);
    await selectCustomSource();
    await applyGatewayModel(model);
  } catch (error) {
    // Restore the URL first so restoreSelection sees the previous gateway and
    // does not demote the saved snapshot to a native one.
    gatewaySettings(settings).activeUrl = previousActiveUrl;
    await restoreSelection(previous, { fast: true }).catch(() => {});
    gatewaySettings(settings).savedCustom = previousSavedCustom;
    saveSettings();
    throw error;
  }

  applyReasoning(entry, level);
  saveSettingsDebounced();
  recordSelection(entry, { native: false, persist });
  saveSettings();
  emitSelectionChanged(entry, { reason });
  // Never delay the switch for the connection check; report the timeout only.
  waitFor(() => online_status !== 'no_connection', STATUS_TIMEOUT_MS).catch(() => {
    console.debug('[omtp] gateway status did not settle; continuing');
  });
  return entry;
}

async function switchToProfile(entry, { level, persist = true, reason } = {}) {
  const command = SlashCommandParser?.commands?.profile;
  if (!command || typeof command.callback !== 'function') {
    throw codedError('profile_disabled', [], 'Connection Profiles extension is not enabled in SillyTavern');
  }
  const name = entry?.profile?.name || entry?.modelLabel || entry?.model;
  if (!name) {
    throw codedError('profile_name', [], 'Connection profile name is missing');
  }

  const settings = getSettings();
  // Taken before leaving the gateway so a failed apply can put ST back on it.
  const previous = captureSelection();
  const previousWasGateway = isGatewayMode();
  const leftGateway = await leaveGatewayMode(settings);

  try {
    // The command resolves to the profile it applied and to '' when SillyTavern
    // cannot find it; reporting success regardless made a no-op look applied.
    const applied = await withTimeout(
      Promise.resolve(command.callback({ quiet: 'true', await: 'true' }, name)),
      PROFILE_TIMEOUT_MS,
      `Connection profile "${name}" did not load (the Connection Profiles extension may be disabled)`,
    );
    if (!applied) {
      throw codedError('profile_unknown', [name], `SillyTavern does not know the connection profile "${name}"`);
    }
    if (String(applied) !== String(name)) {
      // SillyTavern fuzzy-matches profile names, so a typo silently applies a
      // different connection; say so instead of claiming the requested one.
      throw codedError('profile_mismatch', [applied, name], `SillyTavern applied "${applied}" instead of "${name}"`);
    }
    const selected = extension_settings?.connectionManager?.selectedProfile;
    if (entry?.model && selected !== undefined && String(selected) !== String(entry.model)) {
      throw codedError('profile_not_switched', [name], `SillyTavern did not switch to the connection profile "${name}"`);
    }
  } catch (error) {
    if (previousWasGateway || leftGateway) {
      await restoreSelection(previous, { fast: true }).catch(() => {});
    }
    throw error;
  }

  // The profile was applied; the gateway snapshot is no longer needed.
  gatewaySettings(settings).savedCustom = null;
  applyReasoning(entry, level);
  saveSettingsDebounced();
  recordSelection(entry, { native: true, persist });
  saveSettings();
  emitSelectionChanged(entry, { reason });
  return entry;
}

/**
 * Switch to an entry reference (`{kind, provider, model}` or an entry key string).
 * Serialized; throws on unsupported/read-only entries and during generation.
 */
export async function switchToEntry(ref, { reason, level, persist = true } = {}) {
  const entryRef = normalizeRef(ref);
  if (!entryRef) {
    throw codedError('invalid_ref', [], 'Invalid model reference');
  }
  // Auto-routing: natively supported models write ST settings directly;
  // other models route through OMTP gateway automatically without requiring manual toggle.
  const entry = resolveEntry(entryRef);
  if (!entry) {
    throw codedError('unknown_model', [`${entryRef.provider}/${entryRef.model}`], `Unknown model: ${entryRef.provider}/${entryRef.model}`);
  }

  return withSwitchLock(async () => {
    assertCanSwitch();
    console.debug('[omtp] switching', getEntryKey(entryRef), reason ? `(${reason})` : '');

    if (entry.kind === 'profile') {
      return switchToProfile(entry, { level, persist, reason });
    }

    const adapter = entry.nativeAdapter;
    if (adapter && !adapter.readOnlyReason) {
      const supported = !adapter.modelControl
        || typeof adapter.supportsModel !== 'function'
        || adapter.supportsModel(entry.model);
      if (supported) {
        return switchToNative(entry, { level, persist, reason });
      }
    }

    if (entry.gatewayAdapter) {
      return switchToGateway(entry, { level, persist, reason });
    }

    throw entry.unsupportedReason
      ? new Error(entry.unsupportedReason)
      : codedError('unsupported', [entry.model], `Model ${entry.model} is not supported`);
  });
}
