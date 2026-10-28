/**
 * Google Antigravity / Cloud Code Assist (Gemini CLI & Antigravity) gateway adapter.
 *
 * Mirrors OMP's `packages/ai/src/providers/google-gemini-cli.ts` and
 * `packages/catalog/src/discovery/antigravity.ts`:
 *   - Endpoints: `https://daily-cloudcode-pa.googleapis.com` (Antigravity, with
 *     sandbox failover) and `https://cloudcode-pa.googleapis.com` (Gemini CLI).
 *   - Wire path: `POST /v1internal:streamGenerateContent?alt=sse`.
 *   - Discovery: `POST /v1internal:fetchAvailableModels`.
 *   - User-Agent: `antigravity/hub/<version> (aidev_client; os_type=darwin; arch=arm64; cl=963137146)`
 *     or `GeminiCLI/0.46.0/<model> (<platform>; <arch>; terminal)`.
 *   - Claude models on Antigravity send `anthropic-beta: interleaved-thinking-2025-05-14`
 *     and force `toolConfig.functionCallingConfig.mode = "VALIDATED"`.
 */
import { randomUUID } from 'node:crypto';
import {
  JSON_HEADERS,
  contentToText,
  errorResponse,
  hasCredential,
  networkError,
  newCompletionId,
  parseJsonObject,
  sseResponse,
  trimSlash,
  upstreamErrorResponse,
} from './openai.mjs';
import { createGoogleStreamHandler, translateGoogleCompletion } from './google.mjs';
import { parseStructuredCredential } from '../oauth.mjs';

export const id = 'antigravity';

const ANTIGRAVITY_PRIMARY_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';
const ANTIGRAVITY_SANDBOX_ENDPOINT = 'https://daily-cloudcode-pa.sandbox.googleapis.com';
const GEMINI_CLI_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
export const DEFAULT_ANTIGRAVITY_VERSION = '2.19.1';

const DISCOVERY_DENYLIST = new Set(['chat_20706', 'chat_23310', 'gemini-2.5-pro']);

function getAntigravityUserAgent(version = DEFAULT_ANTIGRAVITY_VERSION) {
  const ver = process.env.PI_AI_ANTIGRAVITY_VERSION || version;
  return `antigravity/hub/${ver} (aidev_client; os_type=darwin; arch=arm64; cl=963137146)`;
}

function getGeminiCliUserAgent(modelId = 'gemini-3.1-pro-preview') {
  const ver = process.env.PI_AI_GEMINI_CLI_VERSION || '0.46.0';
  return `GeminiCLI/${ver}/${modelId} (${process.platform}; ${process.arch}; terminal)`;
}

function extractAuth(ctx) {
  const structured = ctx?.credential || parseStructuredCredential(ctx?.apiKey);
  const token = structured?.access || String(ctx?.apiKey || '').replace(/^oauth:/, '').trim();
  const project =
    ctx?.extraConfig?.project ||
    structured?.projectId ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    '';
  return { token, project };
}

function buildAntigravityHeaders(ctx, isClaude = false) {
  const { token } = extractAuth(ctx);
  const isGeminiCli = ctx?.provider === 'google-gemini-cli';
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    ...(isGeminiCli
      ? {
          'User-Agent': getGeminiCliUserAgent(ctx?.model),
          'Client-Metadata': 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI',
        }
      : { 'User-Agent': getAntigravityUserAgent() }),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (!isGeminiCli && isClaude) headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
  return { ...headers, ...(ctx?.headers || {}) };
}

function convertMessagesToCCA(messages) {
  const systemParts = [];
  const contents = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'system' || message.role === 'developer') {
      const text = contentToText(message.content);
      if (text) systemParts.push({ text });
      continue;
    }
    const role = message.role === 'assistant' ? 'model' : 'user';
    const text = contentToText(message.content);
    if (!text) continue;
    const prev = contents[contents.length - 1];
    if (prev && prev.role === role) prev.parts.push({ text });
    else contents.push({ role, parts: [{ text }] });
  }
  return { systemParts, contents };
}

function mapAntigravityWireModel(model, effort = 'low') {
  if (/-(?:minimal|extra-low|low|medium|high|tiered|thinking)$/.test(model)) return model;
  if (model.startsWith('gemini-3.8-flash') || model.startsWith('gemini-4-argon')) {
    const tier = effort === 'high' ? 'high' : effort === 'medium' ? 'medium' : 'low';
    return `${model}-${tier}`;
  }
  return model;
}

function buildEnvelope(req, ctx, project) {
  const isGeminiCli = ctx?.provider === 'google-gemini-cli';
  const rawModel = String(ctx?.model || req?.model || 'gemini-3.1-pro');
  const model = mapAntigravityWireModel(rawModel, req?.reasoning_effort);
  const isClaude = model.toLowerCase().includes('claude');
  const { systemParts, contents } = convertMessagesToCCA(req?.messages);

  const generationConfig = {};
  if (req?.temperature != null) generationConfig.temperature = Number(req.temperature);
  if (req?.top_p != null) generationConfig.topP = Number(req.top_p);
  if (req?.top_k != null) generationConfig.topK = Number(req.top_k);
  const maxTokens = req?.max_completion_tokens ?? req?.max_tokens;
  if (maxTokens != null) {
    const cap = isClaude ? Math.min(Number(maxTokens), 64000) : Number(maxTokens);
    if (cap > 0) generationConfig.maxOutputTokens = cap;
  } else if (!isGeminiCli) {
    generationConfig.maxOutputTokens = 64000;
  }
  if (Array.isArray(req?.stop) && req.stop.length) generationConfig.stopSequences = req.stop;

  const inner = { contents };
  if (systemParts.length > 0) {
    inner.systemInstruction = isGeminiCli ? { parts: systemParts } : { role: 'user', parts: systemParts };
  }
  if (Object.keys(generationConfig).length > 0) inner.generationConfig = generationConfig;

  if (!isGeminiCli && isClaude) {
    inner.toolConfig = { functionCallingConfig: { mode: 'VALIDATED' } };
  }

  if (isGeminiCli) {
    return { contents, model, project, request: inner };
  }

  const trajectoryId = randomUUID();
  inner.labels = {
    last_step_index: '1',
    trajectory_id: trajectoryId,
    used_claude: String(isClaude),
    used_claude_conservative: String(isClaude),
  };
  inner.sessionId = `-${Math.floor(Math.random() * 9e15 + 1e15)}`;
  return {
    contents,
    envelope: {
      project: project || 'cloudaicompanion',
      requestId: `agent/${randomUUID()}/${Date.now()}/${trajectoryId}/2`,
      request: inner,
      model,
      userAgent: 'antigravity',
    },
  };
}

function createCcaStreamHandler(model) {
  const inner = createGoogleStreamHandler(model);
  return {
    onStart: (emit) => inner.onStart?.(emit),
    onEvent: (event, emit) => inner.onEvent(event?.response ?? event, emit),
    onEnd: (emit) => inner.onEnd?.(emit),
  };
}

/**
 * POST to the first endpoint that answers 200/401/403, keeping the last
 * response and the last transport error like the original retry loop.
 */
async function postWithFailover(endpoints, path, { headers, body, signal, doFetch }) {
  let upstream = null;
  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const response = await doFetch(`${endpoint}${path}`, { method: 'POST', headers, body, signal });
      upstream = response;
      if (response.ok || response.status === 401 || response.status === 403) break;
    } catch (error) {
      lastError = error;
    }
  }
  return { upstream, lastError };
}

/** Collect the text/reasoning of a non-streaming CCA response body. */
function parseCcaBody(raw) {
  let text = '';
  let reasoning = '';
  let lastResponse = null;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = parseJsonObject(line.slice(5).trim());
    const response = payload?.response ?? payload;
    if (response?.candidates) lastResponse = response;
    for (const part of response?.candidates?.[0]?.content?.parts || []) {
      if (typeof part?.text === 'string') {
        if (part.thought) reasoning += part.text;
        else text += part.text;
      }
    }
  }
  return { text, reasoning, lastResponse };
}

export async function chat(req, ctx) {
  const { token, project } = extractAuth(ctx);
  if (!token && !hasCredential(ctx)) {
    return errorResponse(`Missing OAuth credential for ${ctx?.provider || 'google-antigravity'}`, {
      status: 401,
      type: 'authentication_error',
      code: 'missing_api_key',
    });
  }

  const built = buildEnvelope(req, ctx, project);
  if (built.contents.length === 0) {
    return errorResponse('At least one non-system message is required', {
      status: 400,
      type: 'invalid_request_error',
      code: 'invalid_messages',
    });
  }
  const body = built.envelope || { project: built.project || 'cloudaicompanion', model: built.model, request: built.request };
  if (ctx?.extraConfig?.body && typeof ctx.extraConfig.body === 'object' && !Array.isArray(ctx.extraConfig.body)) {
    Object.assign(body, ctx.extraConfig.body);
  }

  const isGeminiCli = ctx?.provider === 'google-gemini-cli';
  const configured = trimSlash(ctx?.baseUrl);
  const endpoints = isGeminiCli
    ? [configured || GEMINI_CLI_ENDPOINT]
    : [...new Set([configured || ANTIGRAVITY_PRIMARY_ENDPOINT, ANTIGRAVITY_PRIMARY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT])];

  const isClaude = String(ctx?.model || req?.model || '').toLowerCase().includes('claude');
  const headers = buildAntigravityHeaders(ctx, isClaude);
  const doFetch = ctx?.fetchImpl || fetch;

  const { upstream, lastError } = await postWithFailover(
    endpoints,
    '/v1internal:streamGenerateContent?alt=sse',
    { headers, body: JSON.stringify(body), signal: ctx?.signal, doFetch },
  );

  if (!upstream) return networkError(lastError, 'Antigravity request');
  if (!upstream.ok) return upstreamErrorResponse(upstream);

  const model = String(ctx?.model || req?.model || 'gemini-3.1-pro');
  if (req?.stream) return sseResponse(upstream, createCcaStreamHandler(model));

  const { text, reasoning, lastResponse } = parseCcaBody(await upstream.text());
  const translated = lastResponse
    ? translateGoogleCompletion(lastResponse, model)
    : {
        id: newCompletionId(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      };
  const message = translated?.choices?.[0]?.message;
  if (message && (text || reasoning)) {
    message.content = text;
    if (reasoning) message.reasoning_content = reasoning;
  }
  return new Response(JSON.stringify(translated), { status: 200, headers: JSON_HEADERS });
}

/** Fetch the model map from the first endpoint that accepts the credential. */
async function fetchAvailableModels(endpoints, headers, doFetch, signal) {
  let lastStatus = 0;
  for (const endpoint of endpoints) {
    try {
      const response = await doFetch(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: 'POST',
        headers,
        body: '{}',
        signal,
      });
      lastStatus = response.status;
      if (!response.ok) continue;
      return await response.json();
    } catch {
      /* try next endpoint */
    }
  }
  throw new Error(`Antigravity fetchAvailableModels failed (HTTP ${lastStatus || 'network'})`);
}

/** Strip wire-model suffixes and denylisted entries from the discovery map. */
function toDiscoveredModels(data) {
  const modelsMap = data?.models && typeof data.models === 'object' ? data.models : {};
  const imageIds = new Set(Array.isArray(data?.imageGenerationModelIds) ? data.imageGenerationModelIds : []);
  const seen = new Set();
  const out = [];
  for (const [id, meta] of Object.entries(modelsMap)) {
    if (!id || DISCOVERY_DENYLIST.has(id) || imageIds.has(id)) continue;
    if (meta?.disabled || meta?.isInternal || id.startsWith('tab_') || id.startsWith('chat_')) continue;
    const logicalId = id.replace(/-(?:minimal|extra-low|low|medium|high|tiered|thinking)$/, '');
    if (seen.has(logicalId)) continue;
    seen.add(logicalId);
    const name = typeof meta?.displayName === 'string' && meta.displayName
      ? meta.displayName.replace(/\s*\((?:minimal|low|medium|high|tiered|thinking)\)$/i, '')
      : logicalId;
    out.push({
      id: logicalId,
      name,
      contextWindow: Number(meta?.maxTokens) || 200_000,
      maxTokens: Number(meta?.maxOutputTokens) || 64_000,
      reasoning: Boolean(meta?.supportsThinking),
      input: meta?.supportsImages ? ['text', 'image'] : ['text'],
    });
  }
  return out;
}

export async function listModels(ctx) {
  const configured = trimSlash(ctx?.baseUrl);
  const endpoints = [...new Set([configured || ANTIGRAVITY_PRIMARY_ENDPOINT, ANTIGRAVITY_PRIMARY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT])];
  const headers = { ...buildAntigravityHeaders(ctx, false), Accept: 'application/json' };
  const doFetch = ctx?.fetchImpl || fetch;
  return toDiscoveredModels(await fetchAvailableModels(endpoints, headers, doFetch, ctx?.signal));
}

export default { id, chat, listModels };
