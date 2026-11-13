/**
 * Google Antigravity / Cloud Code Assist (Gemini CLI & Antigravity) gateway adapter.
 *
 * Mirrors OMP's `packages/ai/src/providers/google-gemini-cli.ts` and
 * `packages/catalog/src/discovery/antigravity.ts`:
 *   - Endpoints: `https://daily-cloudcode-pa.googleapis.com` (Antigravity, with
 *     sandbox failover) and `https://cloudcode-pa.googleapis.com` (Gemini CLI).
 *   - Wire path: `POST /v1internal:streamGenerateContent?alt=sse`.
 *   - Discovery: `POST /v1internal:fetchAvailableModels`.
 *   - User-Agent: `antigravity/hub/<version> (aidev_client; os_type=darwin; arch=arm64; cl=<cl>)`
 *     or `GeminiCLI/<version>/<model> (<platform>; <arch>; terminal)`; see `client-versions.mjs`.
 *   - Claude models on Antigravity send `anthropic-beta: interleaved-thinking-2025-05-14`.
 *     Antigravity tool requests default `toolConfig.functionCallingConfig.mode` to
 *     "VALIDATED"; a non-auto `tool_choice` replaces it.
 *   - Tool calls cross the wire as Gemini `functionCall` parts and tool results as
 *     `functionResponse` parts keyed by the assistant call's `tool_call_id`.
 */
import { randomUUID } from 'node:crypto';
import {
    JSON_HEADERS,
    errorResponse,
    hasCredential,
    networkError,
    newCompletionId,
    normalizeTurns,
    parseJsonObject,
    sseResponse,
    translateFunctionTools,
    trimSlash,
    upstreamErrorResponse,
} from './openai.mjs';
import { createGoogleStreamHandler, translateGoogleCompletion } from './google.mjs';
import { parseStructuredCredential } from '../oauth.mjs';
import { antigravityUserAgent, geminiCliUserAgent } from '../client-versions.mjs';

export const id = 'antigravity';

const ANTIGRAVITY_PRIMARY_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';
const ANTIGRAVITY_SANDBOX_ENDPOINT = 'https://daily-cloudcode-pa.sandbox.googleapis.com';
const GEMINI_CLI_ENDPOINT = 'https://cloudcode-pa.googleapis.com';

/** Bypass value Cloud Code Assist accepts in place of a Gemini thought signature. */
const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

const DISCOVERY_DENYLIST = new Set(['chat_20706', 'chat_23310', 'gemini-2.5-pro']);

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
                    'User-Agent': geminiCliUserAgent(ctx?.model || 'gemini-3.1-pro-preview'),
                    'Client-Metadata': 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI',
                }
            : { 'User-Agent': antigravityUserAgent() }),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (!isGeminiCli && isClaude) headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
    return { ...headers, ...(ctx?.headers || {}) };
}

/** Gemini 3+ on Cloud Code Assist rejects an unsigned first function call. */
function requiresFirstCallSignature(model) {
    const revision = /^gemini-(\d+)/i.exec(model);
    return Boolean(revision) && Number(revision[1]) >= 3;
}

/**
 * Convert chat messages into CCA `contents`, mapping assistant `tool_calls` to
 * `functionCall` parts and `role: 'tool'` results to `functionResponse` parts.
 * Responses are named from the assistant call that shares their `tool_call_id`,
 * because Gemini requires a non-empty `functionResponse.name`.
 * @param {any[]} messages OpenAI-shaped messages.
 * @param {string} model Wire model id.
 * @returns {{systemParts: {text: string}[], contents: {role: string, parts: any[]}[]}}
 */
function convertMessagesToCCA(messages, model) {
    const contents = [];
    const toolNames = new Map();
    // Claude routes on CCA pair calls with responses through function-part ids.
    const includeIds = /claude/i.test(model);
    const needsSignature = requiresFirstCallSignature(model);

    const { system } = normalizeTurns(messages, {
        assistantRole: 'model',
        mapSystem: (text) => ({ text }),
        mapText: (text) => ({ text }),
        mapToolCall: (call) => {
            if (call.id) toolNames.set(call.id, call.name);
            return {
                functionCall: {
                    name: call.name,
                    args: call.args,
                    ...(includeIds && call.id ? { id: call.id } : {}),
                },
            };
        },
        mapToolResult: ({ raw, content }) => {
            const callId = raw.tool_call_id || raw.name;
            return {
                functionResponse: {
                    name: toolNames.get(callId) || raw.name || raw.tool_call_id || 'tool',
                    response: { output: content },
                    ...(includeIds && callId ? { id: callId } : {}),
                },
            };
        },
        emitTurn: (role, parts, { isToolResult } = {}) => {
            if (isToolResult) {
                // Cloud Code Assist requires all function responses in one contiguous user turn.
                const prev = contents[contents.length - 1];
                if (prev && prev.role === 'user' && prev.parts.some((item) => item.functionResponse)) {
                    prev.parts.push(...parts);
                } else {
                    contents.push({ role: 'user', parts });
                }
                return;
            }
            const nonEmpty = role === 'user' ? parts.filter((part) => part.text !== '') : parts;
            if (!nonEmpty.length) return;
            if (role === 'model' && needsSignature) {
                // Replayed calls carry no signature, so the bypass sentinel is required
                // on the first call of the turn (secondary parallel calls stay bare).
                const firstCall = nonEmpty.findIndex((part) => part.functionCall);
                if (firstCall !== -1) {
                    nonEmpty[firstCall].thoughtSignature = SKIP_THOUGHT_SIGNATURE;
                }
            }
            const prev = contents[contents.length - 1];
            if (prev && prev.role === role) prev.parts.push(...nonEmpty);
            else contents.push({ role, parts: nonEmpty });
        },
    });
    return { systemParts: system, contents };
}

/** Wrap OpenAI tool definitions as one Gemini `tools` entry. */
function translateTools(tools) {
    const declarations = translateFunctionTools(tools, 'parameters');
    return declarations.length > 0 ? [{ functionDeclarations: declarations }] : [];
}

/**
 * Translate an OpenAI `tool_choice` into Gemini's `functionCallingConfig`.
 * `auto` and unknown values keep the wire default (no config), like OMP's
 * Cloud Code Assist request builder.
 * @param {any} choice
 * @returns {{functionCallingConfig: {mode: string, allowedFunctionNames?: string[]}}|undefined}
 */
function translateToolConfig(choice) {
    if (!choice || choice === 'auto') return undefined;
    if (choice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
    if (choice === 'required' || choice === 'any') return { functionCallingConfig: { mode: 'ANY' } };
    if (typeof choice === 'object') {
        const name = choice.function?.name || choice.name;
        if (name) return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [name] } };
    }
    return undefined;
}

/** Effort tiers Antigravity encodes as a `-<tier>` wire-id suffix, lowest first. */
const EFFORT_TIERS = ['low', 'medium', 'high', 'xhigh'];
const TIER_SUFFIX = /-(?:minimal|extra-low|low|medium|high|xhigh|tiered|thinking)$/;

/**
 * Tier variants per logical id, learned from the last discovery. Families
 * listed below are known before any discovery has run (e.g. after a restart).
 * @type {Map<string, string[]>}
 */
const discoveredTiers = new Map();
const KNOWN_TIERS = [
    ['gemini-3.8-flash', ['low', 'medium', 'high']],
    ['gemini-4-argon', ['low', 'medium', 'high']],
    ['gemini-4-hydrogen', ['low', 'medium', 'high', 'xhigh']],
];

function tiersOf(model) {
    return discoveredTiers.get(model) || KNOWN_TIERS.find(([prefix]) => model.startsWith(prefix))?.[1] || null;
}

/**
 * Pick the wire variant for a logical id: the requested effort's tier, or the
 * highest tier the model has below it. No effort means the lowest tier.
 */
function mapAntigravityWireModel(model, effort) {
    if (TIER_SUFFIX.test(model)) return model;
    const tiers = tiersOf(model);
    if (!tiers) return model;
    const wanted = effort === 'max' || effort === 'xhigh' ? 'xhigh' : effort === 'high' ? 'high' : effort === 'medium' ? 'medium' : 'low';
    const rank = EFFORT_TIERS.indexOf(wanted);
    const tier = [...tiers].reverse().find((candidate) => EFFORT_TIERS.indexOf(candidate) <= rank) || tiers[0];
    return `${model}-${tier}`;
}

function buildEnvelope(req, ctx, project) {
    const isGeminiCli = ctx?.provider === 'google-gemini-cli';
    const rawModel = String(ctx?.model || req?.model || 'gemini-3.1-pro');
    const model = mapAntigravityWireModel(rawModel, req?.reasoning_effort);
    const isClaude = model.toLowerCase().includes('claude');
    const { systemParts, contents } = convertMessagesToCCA(req?.messages, model);

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

    const tools = translateTools(req?.tools);
    if (tools.length > 0) {
        inner.tools = tools;
        const toolConfig = translateToolConfig(req?.tool_choice);
        if (toolConfig) {
            inner.toolConfig = toolConfig;
        } else if (!isGeminiCli) {
            // Antigravity's default tool mode, required by its Claude routes.
            inner.toolConfig = { functionCallingConfig: { mode: 'VALIDATED' } };
        }
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
            // Release a rejected response body before it is overwritten; otherwise
            // the socket and the unread payload linger for the rest of the request.
            if (upstream && upstream !== response) {
                try { await upstream.body?.cancel?.(); } catch { /* body already consumed */ }
            }
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
    if (req?.stream) return sseResponse(upstream, createCcaStreamHandler(model), model);

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
            if (!response.ok) {
                try { await response.body?.cancel?.(); } catch { /* body already consumed */ }
                continue;
            }
            return await response.json();
        } catch {
            /* try next endpoint */
        }
    }
    throw new Error(`Antigravity fetchAvailableModels failed (HTTP ${lastStatus || 'network'})`);
}

/**
 * Collapse `-low`/`-medium`/`-high`/`-xhigh` variants into one logical id
 * (remembering which tiers exist for request mapping) and drop denylisted,
 * disabled, internal and image entries.
 */
function toDiscoveredModels(data) {
    const modelsMap = data?.models && typeof data.models === 'object' ? data.models : {};
    const imageIds = new Set(Array.isArray(data?.imageGenerationModelIds) ? data.imageGenerationModelIds : []);
    const byId = new Map();
    const tiers = new Map();
    for (const [id, meta] of Object.entries(modelsMap)) {
        if (!id || DISCOVERY_DENYLIST.has(id) || imageIds.has(id)) continue;
        if (meta?.disabled || meta?.isInternal || id.startsWith('tab_') || id.startsWith('chat_')) continue;
        const logicalId = id.replace(TIER_SUFFIX, '');
        const tier = /-(low|medium|high|xhigh)$/.exec(id)?.[1];
        if (tier && logicalId !== id) tiers.set(logicalId, [...(tiers.get(logicalId) || []), tier]);
        if (byId.has(logicalId)) continue;
        const name = typeof meta?.displayName === 'string' && meta.displayName
            ? meta.displayName.replace(/\s*\((?:minimal|low|medium|high|xhigh|tiered|thinking)\)$/i, '')
            : logicalId;
        byId.set(logicalId, {
            id: logicalId,
            name,
            contextWindow: Number(meta?.maxTokens) || 200_000,
            maxTokens: Number(meta?.maxOutputTokens) || 64_000,
            reasoning: Boolean(meta?.supportsThinking),
            input: meta?.supportsImages ? ['text', 'image'] : ['text'],
        });
    }
    for (const [logicalId, found] of tiers) {
        // A roster that also serves the bare id takes it as-is.
        if (Object.hasOwn(modelsMap, logicalId)) continue;
        const ordered = EFFORT_TIERS.filter((tier) => found.includes(tier));
        discoveredTiers.set(logicalId, ordered);
        const model = byId.get(logicalId);
        if (model) model.efforts = ordered;
    }
    return [...byId.values()];
}

export async function listModels(ctx) {
    const configured = trimSlash(ctx?.baseUrl);
    const endpoints = [...new Set([configured || ANTIGRAVITY_PRIMARY_ENDPOINT, ANTIGRAVITY_PRIMARY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT])];
    const headers = { ...buildAntigravityHeaders(ctx, false), Accept: 'application/json' };
    const doFetch = ctx?.fetchImpl || fetch;
    return toDiscoveredModels(await fetchAvailableModels(endpoints, headers, doFetch, ctx?.signal));
}

export default { id, chat, listModels };
