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
import { resolveEntry } from './catalog.js';
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

const SWITCH_TIMEOUT_MS = 8000;
const STATUS_TIMEOUT_MS = 8000;
const POLL_INTERVAL_MS = 100;
const PROFILE_TIMEOUT_MS = 20000;
const GATEWAY_STATUS_TTL_MS = 5000;
const GATEWAY_TOKEN_TTL_MS = 60000;
const MAX_RECENTS = 20;

const REASONING_LEVELS = ['auto', 'min', 'low', 'medium', 'high', 'max'];

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
    const response = await fetch('/api/plugins/omtp/providers', { headers: getRequestHeaders({ omitContentType: true }) });
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
  const suffix = api === 'openai' ? source : api === 'textgenerationwebui' ? type : null;
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
  if (typeof ref !== 'object' || !ref.kind || !ref.provider) {
    return null;
  }
  return { kind: ref.kind, provider: ref.provider, model: String(ref.model ?? '') };
}

function isEntryRef(value) {
  return !!value && typeof value === 'object' && typeof value.kind === 'string' && typeof value.provider === 'string';
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

  const adapter = currentAdapter();
  const model = currentModel();
  if (!adapter || !model) {
    return null;
  }
  if (last && last.kind === 'st' && last.provider === adapter.key && last.model === model) {
    return { kind: 'st', provider: last.provider, model: last.model };
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
    Promise.resolve(eventSource.emit('omtp:selection-changed', payload)).catch(error => {
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
    throw new Error(`Unknown reasoning level: ${level}`);
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
export const CHAT_HEADER = 'X-OMTP-Chat';

/** @returns {string} Current SillyTavern chat id, or '' when none is open. */
export function currentChatId() {
  try {
    const ctx = globalThis.SillyTavern?.getContext?.();
    const id = typeof ctx?.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx?.chatId;
    return typeof id === 'string' ? id : '';
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
  const settings = getSettings();
  if (!isGatewayMode()) {
    return false;
  }
  const url = normalizeUrl(settings.gatewayUrl);
  if (!url) {
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
    parsed[CHAT_HEADER] = chatId;
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
  const merged = { ...(parsed ?? {}), ...additions };
  return String(yaml.stringify(merged) ?? '').trimEnd();
}

// MARK: gateway status / token

async function fetchGatewayStatus() {
  const response = await fetch('/api/plugins/omtp/status', { headers: getRequestHeaders() });
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
    const response = await fetch('/api/plugins/omtp/gateway/token', { headers: getRequestHeaders() });
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
export function waitFor(predicate, timeoutMs = SWITCH_TIMEOUT_MS, intervalMs = POLL_INTERVAL_MS) {
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
export function withSwitchLock(fn) {
  const run = switchChain.then(() => fn());
  switchChain = run.then(() => undefined, () => undefined);
  return run;
}

export function assertCanSwitch() {
  if (isGenerating()) {
    throw new Error('Cannot switch while generating');
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
  const candidates = [...new Set([activeGatewayUrl, settings?.gatewayUrl].map(normalizeUrl).filter(Boolean))];
  return candidates.some(url => current === url || current.startsWith(`${url}/`));
}

// MARK: snapshots

export function captureSelection() {
  return {
    ref: detectCurrentRef(),
    mainApi: main_api ?? '',
    chatCompletionSource: main_api === 'openai' ? (oai_settings?.chat_completion_source ?? null) : null,
    textgenType: main_api === 'textgenerationwebui' ? (textgenerationwebui_settings?.type ?? null) : null,
    model: currentModel(),
    reasoningEffort: oai_settings?.reasoning_effort ?? '',
    customUrl: oai_settings?.custom_url ?? '',
    customModel: oai_settings?.custom_model ?? '',
    customIncludeHeaders: oai_settings?.custom_include_headers ?? '',
    customIncludeBody: oai_settings?.custom_include_body ?? '',
    customExcludeBody: oai_settings?.custom_exclude_body ?? '',
    customPromptPostProcessing: oai_settings?.custom_prompt_post_processing ?? '',
  };
}

/** Snapshot of ST's custom-source state, without a selection ref. */
export function captureCustomState() {
  return { ...captureSelection(), ref: null };
}

/**
 * Restore a custom-source snapshot.
 * `fieldsOnly` writes only the custom URL/headers/body/model fields (used when
 * leaving gateway mode, where the API/source is set by the following switch).
 */
export async function restoreCustomState(snapshot, { fast = false, fieldsOnly = false } = {}) {
  if (!snapshot || typeof snapshot !== 'object') {
    return false;
  }
  writeCustomFields(snapshot);
  if (fieldsOnly) {
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
  const target = requested || stored;

  if (!target) {
    return;
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

export async function switchToNative(entry, { level, persist = true } = {}) {
  const adapter = entry?.nativeAdapter;
  if (!adapter) {
    throw new Error(`No native SillyTavern adapter for ${entry?.provider ?? 'unknown provider'}`);
  }
  if (adapter.readOnlyReason) {
    throw new Error(adapter.readOnlyReason);
  }
  if (adapter.mainApi === 'kobold' || adapter.mainApi === 'koboldhorde') {
    throw new Error('Read-only provider; manage it in the native UI');
  }
  if (adapter.modelControl && typeof adapter.supportsModel === 'function' && !adapter.supportsModel(entry.model)) {
    throw new Error(`Model ${entry.model} is not available in ${adapter.label || adapter.key}`);
  }
  if (!jq('#main_api')) {
    throw new Error('SillyTavern UI is not ready');
  }

  const settings = getSettings();
  const previous = captureSelection();

  if (gatewaySettings(settings).savedCustom) {
    // Resolve the live gateway port so isGatewayMode() is accurate after a reload.
    await getGatewayStatus();
  }
  if (isGatewayMode() && gatewaySettings(settings).savedCustom) {
    await restoreCustomState(gatewaySettings(settings).savedCustom, { fast: true, fieldsOnly: true });
    gatewaySettings(settings).savedCustom = null;
  }

  setControlValue('#main_api', adapter.mainApi, 'change');
  await waitFor(() => main_api === adapter.mainApi).catch(() => {
    throw new Error(`Failed to switch the API to ${adapter.mainApi}`);
  });

  if (adapter.mainApi === 'openai' && adapter.source) {
    if (!setControlValue('#chat_completion_source', adapter.source, 'change')) {
      throw new Error(`Failed to select the chat completion source ${adapter.source}`);
    }
    await waitFor(() => oai_settings.chat_completion_source === adapter.source).catch(() => {
      throw new Error(`Failed to select the chat completion source ${adapter.source}`);
    });
  } else if (adapter.mainApi === 'textgenerationwebui' && adapter.type) {
    if (!setControlValue('#textgen_type', adapter.type, 'change')) {
      throw new Error(`Failed to select the text generation type ${adapter.type}`);
    }
    await waitFor(() => textgenerationwebui_settings.type === adapter.type).catch(() => {
      throw new Error(`Failed to select the text generation type ${adapter.type}`);
    });
  } else if (adapter.mainApi === 'novel') {
    if (!setControlValue('#model_novel_select', entry.model, 'change')) {
      throw new Error(`Model ${entry.model} is not available in NovelAI`);
    }
    await waitFor(() => nai_settings.model_novel === entry.model).catch(() => {
      throw new Error(`Failed to select the NovelAI model ${entry.model}`);
    });
  }

  if (!adapter.modelControl) {
    throw new Error('Read-only provider; manage it in the native UI');
  }

  if (adapter.mainApi !== 'novel') {
    if (!jq(adapter.modelControl)) {
      throw new Error(`Native model control not found: ${adapter.modelControl}`);
    }
    if (!setControlValue(adapter.modelControl, entry.model)) {
      throw new Error(`Model ${entry.model} is not available in ${adapter.label || adapter.key}`);
    }
    await waitFor(() => String(readSettingField(adapter.mainApi, adapter.modelField) ?? '') === String(entry.model)).catch(() => {
      throw new Error(`Failed to apply the model ${entry.model}`);
    });
  }

  applyReasoning(entry, level);
  saveSettingsDebounced();

  if (online_status === 'no_connection' && adapter.connectButton) {
    const button = jq(adapter.connectButton);
    if (button) {
      button.trigger('click');
      try {
        await waitFor(() => online_status !== 'no_connection', STATUS_TIMEOUT_MS);
      } catch {
        await restoreSelection(previous, { fast: true });
        throw new Error(`Connection failed for ${adapter.label || adapter.key}`);
      }
    }
  }

  recordSelection(entry, { native: true, persist });
  saveSettings();
  emitSelectionChanged(entry);
  return entry;
}

export async function switchToGateway(entry, { level, persist = true } = {}) {
  const settings = getSettings();
  if (!entry?.gatewayAdapter) {
    throw new Error(entry?.unsupportedReason || `Provider ${entry?.providerLabel || entry?.provider || 'unknown'} is not supported`);
  }
  if (entry.available === false) {
    throw new Error(entry.unsupportedReason || `Provider ${entry.providerLabel || entry.provider} has no usable API key`);
  }

  const modelId = String(entry.model ?? '');
  if (!modelId) {
    throw new Error('Gateway model id is missing');
  }
  const model = `${entry.provider}/${modelId}`;

  const status = await getGatewayStatus();
  if (!status.running) {
    throw new Error(status.lastError ? `OMTP Gateway unavailable: ${status.lastError}` : 'OMTP Gateway unavailable (enable server plugins)');
  }
  const providerStatuses = await getProviderStatuses();
  const providerStatus = providerStatuses?.get(String(entry.provider));
  if (providerStatus && providerStatus.available === false) {
    const label = providerStatus.label || entry.provider;
    throw new Error(providerStatus.keyInvalidReason
      ? `Provider ${label} rejected its key (${providerStatus.keyInvalidReason})`
      : `Provider ${label} needs an API key; configure it in OMTP settings`);
  }
  const gatewayUrl = status.url || normalizeUrl(settings.gatewayUrl);
  if (!gatewayUrl) {
    throw new Error('OMTP Gateway URL is not configured');
  }
  const token = await resolveGatewayToken({ ...status, url: gatewayUrl });
  if (status.requireAuth && !token) {
    throw new Error('OMTP Gateway token is unavailable');
  }
  if (!jq('#main_api')) {
    throw new Error('SillyTavern UI is not ready');
  }

  if (!isGatewayMode()) {
    gatewaySettings(settings).savedCustom = captureCustomState();
  }

  setControlValue('#main_api', 'openai', 'change');
  await waitFor(() => main_api === 'openai').catch(() => {
    throw new Error('Failed to switch the API to openai');
  });

  // Custom URL, headers and model must be in place before the source changes,
  // because the source change immediately validates the endpoint.
  oai_settings.custom_url = gatewayUrl;
  setControlValue('#custom_api_url_text', gatewayUrl);

  if (status.requireAuth && token) {
    const headers = mergeYamlHeaders(oai_settings.custom_include_headers, {
      Authorization: `Bearer ${token}`,
      [CHAT_HEADER]: currentChatId(),
    });
    oai_settings.custom_include_headers = headers;
    setControlValue('#custom_include_headers', headers);
  }

  oai_settings.custom_model = model;
  setControlValue('#custom_model_id', model);

  if (jq('#chat_completion_source')) {
    if (!setControlValue('#chat_completion_source', 'custom', 'change')) {
      throw new Error('Failed to select the custom chat completion source');
    }
  } else {
    oai_settings.chat_completion_source = 'custom';
  }
  await waitFor(() => oai_settings.chat_completion_source === 'custom').catch(() => {
    throw new Error('Failed to select the custom chat completion source');
  });

  // Switching the source repopulates `#model_custom_select` and rewrites
  // `custom_model` from whatever that select currently shows, so the model has
  // to be applied again once the source has settled.
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
    throw new Error(`Failed to set the gateway model ${model}`);
  });
  await waitFor(() => online_status !== 'no_connection', STATUS_TIMEOUT_MS).catch(() => {
    console.debug('[omtp] gateway status did not settle; continuing');
  });

  applyReasoning(entry, level);
  saveSettingsDebounced();
  recordSelection(entry, { native: false, persist });
  saveSettings();
  emitSelectionChanged(entry);
  return entry;
}

export async function switchToProfile(entry) {
  const command = SlashCommandParser?.commands?.profile;
  if (!command || typeof command.callback !== 'function') {
    throw new Error('Connection Profiles extension is not enabled');
  }
  const name = entry?.profile?.name || entry?.modelLabel || entry?.model;
  if (!name) {
    throw new Error('Connection profile name is missing');
  }

  const settings = getSettings();
  if (gatewaySettings(settings).savedCustom) {
    await getGatewayStatus();
  }
  if (isGatewayMode() && gatewaySettings(settings).savedCustom) {
    await restoreCustomState(gatewaySettings(settings).savedCustom, { fast: true, fieldsOnly: true });
    gatewaySettings(settings).savedCustom = null;
  }

  await withTimeout(
    Promise.resolve(command.callback({ quiet: 'true', await: 'true' }, name)),
    PROFILE_TIMEOUT_MS,
    `Connection profile "${name}" did not load`,
  );

  saveSettingsDebounced();
  recordSelection(entry, { native: true });
  saveSettings();
  emitSelectionChanged(entry);
  return entry;
}

/**
 * Switch to an entry reference (`{kind, provider, model}` or an entry key string).
 * Serialized; throws on unsupported/read-only entries and during generation.
 */
export async function switchToEntry(ref, { reason, level, persist = true } = {}) {
  const entryRef = normalizeRef(ref);
  if (!entryRef) {
    throw new Error('Invalid model reference');
  }
  // Auto-routing: natively supported models write ST settings directly;
  // other models route through OMTP gateway automatically without requiring manual toggle.
  const entry = resolveEntry(entryRef);
  if (!entry) {
    throw new Error(`Unknown model: ${entryRef.provider}/${entryRef.model}`);
  }

  return withSwitchLock(async () => {
    assertCanSwitch();
    console.debug('[omtp] switching', getEntryKey(entryRef), reason ? `(${reason})` : '');

    if (entry.kind === 'profile') {
      return switchToProfile(entry);
    }

    const adapter = entry.nativeAdapter || (entry.stKey ? NATIVE_ADAPTERS.get(entry.stKey) : null);
    if (adapter && !adapter.readOnlyReason) {
      const supported = !adapter.modelControl
        || typeof adapter.supportsModel !== 'function'
        || adapter.supportsModel(entry.model);
      if (supported) {
        return switchToNative(entry, { level, persist });
      }
    }

    if (entry.gatewayAdapter) {
      return switchToGateway(entry, { level, persist });
    }

    throw new Error(entry.unsupportedReason || `Model ${entry.model} is not supported`);
  });
}
