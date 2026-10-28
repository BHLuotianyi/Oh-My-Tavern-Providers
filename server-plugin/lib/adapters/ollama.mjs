/** Ollama OpenAI-compatibility gateway adapter. */
import {
  authHeaders,
  joinUrl,
  missingBaseUrl,
  networkError,
  passthroughJson,
  resolveBaseUrl,
  trimSlash,
  upstreamErrorResponse,
} from './openai.mjs';
import { sseHeaders } from '../sse.mjs';

export const id = 'ollama';

export async function chat(req, ctx) {
  if (!ctx?.baseUrl) return missingBaseUrl();

  const body = { ...(req || {}), model: ctx.model };
  const url = joinUrl(resolveBaseUrl(ctx.baseUrl, ctx.extraConfig || {}), '/chat/completions');
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
    return networkError(error, 'Ollama request');
  }

  if (!upstream.ok) return upstreamErrorResponse(upstream);
  if (body.stream) return new Response(upstream.body, { status: 200, headers: sseHeaders() });
  return passthroughJson(upstream);
}

export async function listModels(ctx) {
  const base = trimSlash(ctx?.baseUrl || 'http://127.0.0.1:11434');
  const doFetch = ctx?.fetchImpl || fetch;
  try {
    const response = await doFetch(`${base}/api/tags`, { signal: ctx?.signal });
    if (response.ok) {
      const json = await response.json();
      const models = Array.isArray(json?.models) ? json.models : [];
      return models.map((m) => ({ id: m.name || m.model, name: m.name || m.model }));
    }
  } catch {
    // fallback
  }
  const response = await doFetch(`${base}/v1/models`, {
    headers: authHeaders(ctx),
    signal: ctx?.signal,
  });
  if (!response.ok) throw new Error(`Ollama listModels failed: HTTP ${response.status}`);
  const json = await response.json();
  const list = Array.isArray(json?.data) ? json.data : [];
  return list.map((m) => ({ id: m.id, name: m.name || m.id }));
}

export default { id, chat, listModels };
