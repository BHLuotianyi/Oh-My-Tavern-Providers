/**
 * OpenAI-compatible gateway adapter.
 *
 * This module also hosts the transport helpers shared by the other protocol
 * adapters, so every adapter imports its scaffolding from here.
 */
import { parseSse, done, sseHeaders } from '../sse.mjs';
import { KEYLESS_PROVIDERS } from '../provider-config.mjs';

export const id = 'openai';

export const JSON_HEADERS = Object.freeze({ 'Content-Type': 'application/json; charset=utf-8' });

const KEYLESS = new Set(KEYLESS_PROVIDERS);

export function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

/**
 * Resolve `{region}`/`{location}` style placeholders used by catalog base URLs.
 */
export function resolveBaseUrl(baseUrl, extra = {}) {
  const region = extra?.region || 'us-east-1';
  return String(baseUrl || '')
    .replace(/\{region\}/g, region)
    .replace(/\{location\}/g, region);
}

/**
 * Append a path to a base URL, keeping an already-complete URL untouched.
 * OpenAI-compatible base URLs are expected to include `/v1`.
 */
export function joinUrl(baseUrl, suffix) {
  const base = trimSlash(baseUrl);
  if (!base) return '';
  const tail = suffix.startsWith('/') ? suffix : `/${suffix}`;
  if (base.endsWith(tail)) return base;
  return `${base}${tail}`;
}

export function hasHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return false;
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target && Boolean(headers[key]));
}

export function hasCredential(ctx) {
  if (ctx?.apiKey) return true;
  return (
    hasHeader(ctx?.headers, 'authorization') ||
    hasHeader(ctx?.headers, 'x-api-key') ||
    hasHeader(ctx?.headers, 'api-key') ||
    hasHeader(ctx?.headers, 'x-goog-api-key')
  );
}

export function isKeyless(ctx) {
  if (ctx?.extraConfig?.allowNoKey === true) return true;
  if (KEYLESS.has(ctx?.provider)) return true;
  try {
    const host = new URL(ctx?.baseUrl || '').hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host === '[::1]' ||
      host.endsWith('.localhost')
    );
  } catch {
    return false;
  }
}

/**
 * Build auth headers for a provider. `ctx.headers` always wins so provider
 * config overrides are respected.
 */
export function authHeaders(ctx, scheme = 'bearer') {
  const headers = {};
  if (ctx?.apiKey) {
    if (scheme === 'x-api-key') headers['x-api-key'] = ctx.apiKey;
    else if (scheme === 'api-key') headers['api-key'] = ctx.apiKey;
    else if (scheme === 'x-goog-api-key') headers['x-goog-api-key'] = ctx.apiKey;
    else headers.Authorization = `Bearer ${ctx.apiKey}`;
  }
  return { ...headers, ...(ctx?.headers && typeof ctx.headers === 'object' ? ctx.headers : {}) };
}

export function errorResponse(
  message,
  { status = 500, type = 'omtp_gateway_error', code = null, param = null } = {},
) {
  const error = { message: String(message || 'Unknown error'), type, code };
  if (param) error.param = param;
  return new Response(JSON.stringify({ error }), { status, headers: JSON_HEADERS });
}

/** 400 response for a provider without a usable base URL. */
export function missingBaseUrl() {
  return errorResponse('Provider baseUrl is not configured', {
    status: 400,
    type: 'invalid_request_error',
    code: 'missing_base_url',
  });
}

/** 401 response for a provider whose credentials are absent. */
export function missingApiKey(ctx, fallback) {
  return errorResponse(`Missing API key for provider ${ctx?.provider || fallback}`, {
    status: 401,
    type: 'authentication_error',
    code: 'missing_api_key',
  });
}

/** 400 response for a request with no user/assistant content. */
export function invalidMessages() {
  return errorResponse('At least one non-system message is required', {
    status: 400,
    type: 'invalid_request_error',
    code: 'invalid_messages',
  });
}

/** 502 response for an upstream body that is not the JSON we expect. */
export function invalidResponse(label, error) {
  return errorResponse(`Invalid ${label}: ${error?.message || error}`, {
    status: 502,
    type: 'upstream_error',
    code: 'invalid_response',
  });
}

export function isAbortError(error) {
  return Boolean(
    error &&
      (error.name === 'AbortError' || error.code === 'ABORT_ERR' || error.code === 'ERR_CANCELED'),
  );
}

export function networkError(error, label = 'Upstream request') {
  if (isAbortError(error)) {
    return errorResponse(`${label} aborted`, { status: 499, type: 'aborted', code: 'aborted' });
  }
  return errorResponse(`${label} failed: ${error?.message || error}`, {
    status: 502,
    type: 'upstream_error',
    code: 'network_error',
  });
}

/** Convert a non-OK upstream response into the OpenAI error envelope. */
export async function upstreamErrorResponse(upstream) {
  let text = '';
  try {
    text = await upstream.text();
  } catch {
    text = '';
  }
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  const raw = payload?.error;
  const message =
    (typeof raw === 'string' ? raw : raw?.message) ||
    payload?.message ||
    text.slice(0, 2000) ||
    `Upstream returned HTTP ${upstream.status}`;
  const type =
    raw?.type ||
    payload?.type ||
    (upstream.status === 401 || upstream.status === 403 ? 'authentication_error' : 'upstream_error');
  const code = raw?.code ?? payload?.code ?? upstream.status;
  return errorResponse(message, { status: upstream.status || 502, type, code });
}

export async function passthroughJson(upstream) {
  const text = await upstream.text();
  const contentType = upstream.headers?.get?.('content-type') || JSON_HEADERS['Content-Type'];
  return new Response(text, { status: upstream.status || 200, headers: { 'Content-Type': contentType } });
}

/**
 * Run the fetch/stream/decode half of a JSON adapter exchange.
 *
 * Adapters keep their own guard clauses and request building (both are
 * protocol specific) and hand the finished request here; everything after it
 * is identical across the JSON adapters.
 *
 * @param {object} options
 * @param {string} options.url
 * @param {Record<string, string>} options.headers
 * @param {Record<string, any>} options.payload Serialized as the JSON body.
 * @param {string} options.label Base name for errors ("Anthropic", "Google").
 * @param {string} [options.invalidLabel] Overrides `Invalid <label> response`.
 * @param {boolean} [options.stream] Return the upstream SSE stream as-is.
 * @param {() => any} [options.streamHandler] Factory for the SSE translator.
 * @param {(json: any) => any} options.translate Builds the completion payload.
 * @param {any} options.ctx Resolved provider context (`fetchImpl`, `signal`).
 */
export async function runJsonAdapter({
  url,
  headers,
  payload,
  label,
  invalidLabel = `${label} response`,
  stream = false,
  streamHandler,
  translate,
  ctx,
}) {
  const doFetch = ctx?.fetchImpl || fetch;
  let upstream;
  try {
    upstream = await doFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ctx?.signal,
    });
  } catch (error) {
    return networkError(error, `${label} request`);
  }

  if (!upstream.ok) return upstreamErrorResponse(upstream);
  if (stream) return sseResponse(upstream, streamHandler());
  let json;
  try {
    json = await upstream.json();
  } catch (error) {
    return invalidResponse(invalidLabel, error);
  }
  return new Response(JSON.stringify(translate(json)), { status: 200, headers: JSON_HEADERS });
}

/** Normalize whatever parseSse yields into a parsed event object. */
export function coerceSseEvent(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text || text === '[DONE]') return null;
    return JSON.parse(text);
  }
  if (typeof raw === 'object') {
    if (typeof raw.data === 'string' && raw.type === undefined && raw.candidates === undefined) {
      const text = raw.data.trim();
      if (!text || text === '[DONE]') return null;
      return JSON.parse(text);
    }
    return raw;
  }
  return null;
}

export function errorFrame(error) {
  const message = error?.message || String(error || 'Upstream stream error');
  return `data: ${JSON.stringify({ error: { message, type: 'upstream_error' } })}\n\n`;
}

/**
 * Build an OpenAI-shaped usage object, keeping the cache/reasoning breakdown so
 * the gateway's token accounting (and SillyTavern's own display) can use it.
 * @param {{prompt?:number, completion?:number, cached?:number, cacheWrite?:number, reasoning?:number, total?:number}} parts
 */
export function openAIUsage({ prompt = 0, completion = 0, cached = 0, cacheWrite = 0, reasoning = 0, total } = {}) {
    const promptTokens = Number(prompt) || 0;
    const completionTokens = Number(completion) || 0;
    const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: Number(total) || promptTokens + completionTokens,
    };
    if (cached || cacheWrite) {
        usage.prompt_tokens_details = {
            ...(cached ? { cached_tokens: Number(cached) } : {}),
            ...(cacheWrite ? { cache_write_tokens: Number(cacheWrite) } : {}),
        };
    }
    if (reasoning) {
        usage.completion_tokens_details = { reasoning_tokens: Number(reasoning) };
    }
    return usage;
}

export function usageFrame(usage, model = '') {
  return `data: ${JSON.stringify({
    id: `chatcmpl-${globalThis.crypto?.randomUUID?.() || Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
    usage,
  })}\n\n`;
}

export function newCompletionId() {
  return `chatcmpl-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

/**
 * Wrap an upstream SSE response with a translator.
 *
 * handler = { onStart?(emit), onEvent(event, emit), onEnd?(emit) }
 * `emit` accepts either an already-formatted SSE frame (string) or an object
 * that is serialized into a data frame.
 */
export function sseResponse(upstream, handler) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      const emit = (frame) => {
        if (frame == null) return;
        const text = typeof frame === 'string' ? frame : `data: ${JSON.stringify(frame)}\n\n`;
        if (!text) return;
        controller.enqueue(encoder.encode(text));
      };
      try {
        handler?.onStart?.(emit);
        for await (const raw of parseSse(upstream.body)) {
          const event = coerceSseEvent(raw);
          if (!event) continue;
          await handler?.onEvent?.(event, emit);
        }
        await handler?.onEnd?.(emit);
        emit(done());
      } catch (error) {
        if (!isAbortError(error)) emit(errorFrame(error));
      } finally {
        try {
          controller.close();
        } catch {
          /* stream already closed */
        }
      }
    },
    cancel(reason) {
      try {
        const result = upstream.body?.cancel?.(reason);
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch {
        /* ignore cancel errors */
      }
    },
  });
  return new Response(body, { status: 200, headers: sseHeaders() });
}

/**
 * Wrap a one-shot finish block: the terminal chunk and the usage frame are
 * emitted at most once, whichever of `message_stop` / `onEnd` fires first.
 * @param {() => any} buildFinishChunk
 * @param {() => any} buildUsageFrame Returns a frame, or null when there is no usage.
 */
export function createFinishEmitter(buildFinishChunk, buildUsageFrame) {
  let finished = false;
  return (emit) => {
    if (finished) return;
    finished = true;
    emit(buildFinishChunk());
    const usage = buildUsageFrame();
    if (usage) emit(usage);
  };
}

export function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

/**
 * Split a `data:<mime>;base64,<payload>` URL into its parts.
 * @param {string} url
 * @returns {{mimeType: string, data: string}|null}
 */
export function parseDataUrl(url) {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url || '');
  return match ? { mimeType: match[1], data: match[2] } : null;
}

export function parseJsonObject(value) {
  if (value == null || value === '') return {};
  if (typeof value === 'object') return Array.isArray(value) ? {} : value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Normalize OpenAI-style `tools` into a vendor schema keyed by `schemaKey`
 * (`input_schema` for Anthropic, `parameters` for the Responses API).
 * @param {any} tools
 * @param {string} schemaKey
 * @param {Record<string, any>} [extra] Leading fields such as `{ type: 'function' }`.
 */
export function translateFunctionTools(tools, schemaKey, extra = {}) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const tool of tools) {
    const fn = tool?.function || tool;
    if (!fn?.name) continue;
    const entry = { ...extra, name: fn.name };
    if (fn.description) entry.description = fn.description;
    entry[schemaKey] =
      fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} };
    out.push(entry);
  }
  return out;
}

/** Append content blocks to a role message, merging consecutive same-role turns. */
export function pushContent(list, role, parts) {
  if (!parts || parts.length === 0) return;
  const last = list[list.length - 1];
  if (last && last.role === role) {
    if (Array.isArray(last.content)) last.content.push(...parts);
    else last.content = parts;
  } else {
    list.push({ role, content: parts });
  }
}

export async function chat(req, ctx) {
  if (!ctx?.baseUrl) return missingBaseUrl();
  if (!hasCredential(ctx) && !isKeyless(ctx)) return missingApiKey(ctx, 'unknown');

  const extra = ctx.extraConfig && typeof ctx.extraConfig === 'object' ? ctx.extraConfig : {};
  const body = { ...(req || {}) };

  if (extra.omitReasoningEffort) delete body.reasoning_effort;
  if (extra.maxCompletionTokens && body.max_completion_tokens === undefined && body.max_tokens !== undefined) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
  }
  if (extra.body && typeof extra.body === 'object' && !Array.isArray(extra.body)) {
    Object.assign(body, extra.body);
  }
  body.model = ctx.model || body.model;
  body.stream = Boolean(req?.stream);
  const url = joinUrl(resolveBaseUrl(ctx.baseUrl, extra), '/chat/completions');
  const doFetch = ctx.fetchImpl || fetch;
  let upstream;
  try {
    upstream = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(ctx) },
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
  } catch (error) {
    return networkError(error);
  }

  if (!upstream.ok) return upstreamErrorResponse(upstream);
  if (body.stream) return new Response(upstream.body, { status: 200, headers: sseHeaders() });
  return passthroughJson(upstream);
}

export async function listModels(ctx) {
  const baseUrl = trimSlash(ctx?.baseUrl);
  if (!baseUrl) return [];
  const modelsUrl = /\/v\d+$/.test(baseUrl) ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
  const doFetch = ctx?.fetchImpl || fetch;
  const response = await doFetch(modelsUrl, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', ...authHeaders(ctx) },
    signal: ctx?.signal,
  });
  if (!response.ok) {
    throw new Error(`OpenAI listModels failed: HTTP ${response.status}`);
  }
  const json = await response.json();
  const list = [json?.data, json?.models, json].find(Array.isArray) || [];
  return list.map((item) => ({
    id: typeof item === 'string' ? item : item.id,
    name: typeof item === 'string' ? item : item.name || item.id,
  }));
}

export default { id, chat, listModels };
