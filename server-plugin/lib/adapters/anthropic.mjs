/** Anthropic Messages API gateway adapter. */
import {
  JSON_HEADERS,
  authHeaders,
  contentToText,
  errorResponse,
  hasCredential,
  networkError,
  newCompletionId,
  parseJsonObject,
  pushContent,
  sseResponse,
  trimSlash,
  upstreamErrorResponse,
  usageFrame,
  openAIUsage,
} from './openai.mjs';
import { openAIChunk } from '../sse.mjs';

export const id = 'anthropic';
export const DEFAULT_CLAUDE_CODE_VERSION = '2.1.280';
export const CLAUDE_CODE_SYSTEM_INSTRUCTION = "You are Claude Code, Anthropic's official CLI for Claude.";
export const CLAUDE_CODE_BETAS = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27';

export function isClaudeCode(ctx) {
  if (ctx?.extraConfig?.claudeCode || ctx?.provider === 'claude-code') return true;
  if (typeof ctx?.apiKey === 'string' && (ctx.apiKey.startsWith('sk-ant-acc') || ctx.apiKey.startsWith('oauth:'))) return true;
  return false;
}

const DEFAULT_MAX_TOKENS = 8192;
const ANTHROPIC_VERSION = '2023-06-01';
const THINKING_BUDGETS = { min: 1024, low: 2048, medium: 8192, high: 16384, max: 32768 };
function messagesUrl(baseUrl) {
  const base = trimSlash(baseUrl);
  if (/\/messages$/.test(base)) return base;
  if (/\/v1$/.test(base)) return `${base}/messages`;
  return `${base}/v1/messages`;
}

function dataUrlImage(url) {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url || '');
  if (!match) return null;
  return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
}

function imageBlock(part) {
  const url = part?.image_url?.url || part?.image_url || part?.url;
  if (!url) return null;
  const inline = dataUrlImage(url);
  if (inline) return inline;
  return { type: 'image', source: { type: 'url', url } };
}

function translateMessages(messages) {
  const system = [];
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    const role = message.role;
    if (role === 'system' || role === 'developer') {
      const text = contentToText(message.content);
      if (text) system.push(text);
      continue;
    }
    if (role === 'tool' || role === 'function') {
      pushContent(out, 'user', [
        {
          type: 'tool_result',
          tool_use_id: message.tool_call_id || message.name || '',
          content: contentToText(message.content),
        },
      ]);
      continue;
    }
    if (role === 'assistant') {
      const blocks = [];
      const text = contentToText(message.content);
      if (text) blocks.push({ type: 'text', text });
      for (const call of message.tool_calls || []) {
        const fn = call.function || call;
        blocks.push({
          type: 'tool_use',
          id: call.id || `toolu_${blocks.length}`,
          name: fn.name || call.name || 'tool',
          input: parseJsonObject(fn.arguments ?? call.arguments),
        });
      }
      if (blocks.length) pushContent(out, 'assistant', blocks);
      continue;
    }
    const blocks = [];
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (typeof part === 'string') {
          blocks.push({ type: 'text', text: part });
        } else if (part?.type === 'text' && typeof part.text === 'string') {
          blocks.push({ type: 'text', text: part.text });
        } else if (part?.type === 'image_url' || part?.type === 'image') {
          const block = imageBlock(part);
          if (block) blocks.push(block);
        }
      }
    } else {
      const text = contentToText(message.content);
      if (text) blocks.push({ type: 'text', text });
    }
    if (blocks.length) pushContent(out, 'user', blocks);
  }
  return { system: system.join('\n\n'), messages: out };
}

function translateTools(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const tool of tools) {
    const fn = tool?.function || tool;
    if (!fn?.name) continue;
    const entry = { name: fn.name };
    if (fn.description) entry.description = fn.description;
    entry.input_schema =
      fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} };
    out.push(entry);
  }
  return out;
}

function translateToolChoice(choice) {
  if (!choice) return undefined;
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required' || choice === 'any') return { type: 'any' };
  if (typeof choice === 'object') {
    const name = choice.function?.name || choice.name;
    if (name) return { type: 'tool', name };
  }
  return undefined;
}

function resolveMaxTokens(req, extra, modelInfo) {
  const raw =
    req.max_completion_tokens ??
    req.max_tokens ??
    extra.maxTokens ??
    modelInfo?.maxTokens ??
    DEFAULT_MAX_TOKENS;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_TOKENS;
}

function buildThinking(effort, maxTokens) {
  if (!effort || effort === 'auto') return { thinking: null, maxTokens };
  const wanted = THINKING_BUDGETS[effort];
  if (!wanted) return { thinking: null, maxTokens };
  let nextMax = maxTokens;
  const budget = Math.min(wanted, Math.max(1024, maxTokens - 1));
  if (budget >= nextMax) nextMax = budget + 1024;
  return { thinking: { type: 'enabled', budget_tokens: budget }, maxTokens: nextMax };
}

function mapStopReason(reason) {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return reason ? 'stop' : 'stop';
  }
}

function translateCompletion(json, model) {
  const blocks = Array.isArray(json?.content) ? json.content : [];
  let text = '';
  let reasoning = '';
  const toolCalls = [];
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
    else if (block?.type === 'thinking' && typeof block.thinking === 'string') reasoning += block.thinking;
    else if (block?.type === 'tool_use') {
      toolCalls.push({
        id: block.id || `call_${toolCalls.length}`,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  const message = { role: 'assistant', content: text || (toolCalls.length ? null : '') };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  const inputTokens = Number(json?.usage?.input_tokens) || 0;
  const outputTokens = Number(json?.usage?.output_tokens) || 0;
  // Anthropic reports cache reads/writes outside `input_tokens`; OpenAI's
  // `prompt_tokens` includes them, so fold them back in.
  const cacheRead = Number(json?.usage?.cache_read_input_tokens) || 0;
  const cacheWrite = Number(json?.usage?.cache_creation_input_tokens) || 0;
  return {
    id: json?.id || newCompletionId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: json?.model || model,
    choices: [{ index: 0, message, finish_reason: mapStopReason(json?.stop_reason) }],
    usage: openAIUsage({
      prompt: inputTokens + cacheRead + cacheWrite,
      completion: outputTokens,
      cached: cacheRead,
      cacheWrite,
    }),
  };
}

function createStreamHandler(model) {
  const toolIndexByBlock = new Map();
  let toolIndex = 0;
  let finishReason = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let finished = false;

  const finish = (emit) => {
    if (finished) return;
    finished = true;
    emit(openAIChunk({}, finishReason || 'stop'));
    if (inputTokens || outputTokens || cacheReadTokens || cacheWriteTokens) {
      emit(
        usageFrame(
          openAIUsage({
            prompt: inputTokens + cacheReadTokens + cacheWriteTokens,
            completion: outputTokens,
            cached: cacheReadTokens,
            cacheWrite: cacheWriteTokens,
          }),
          model,
        ),
      );
    }
  };

  return {
    onStart(emit) {
      emit(openAIChunk({ role: 'assistant', content: '' }));
    },
    onEvent(event, emit) {
      const type = event?.type;
      if (type === 'message_start') {
        const usage = event.message?.usage;
        if (usage) {
          inputTokens = Number(usage.input_tokens) || 0;
          outputTokens = Number(usage.output_tokens) || 0;
          cacheReadTokens = Number(usage.cache_read_input_tokens) || 0;
          cacheWriteTokens = Number(usage.cache_creation_input_tokens) || 0;
        }
        return;
      }
      if (type === 'content_block_start') {
        const block = event.content_block || {};
        if (block.type === 'tool_use') {
          const index = toolIndex++;
          toolIndexByBlock.set(event.index, index);
          emit(
            openAIChunk({
              tool_calls: [
                { index, id: block.id, type: 'function', function: { name: block.name, arguments: '' } },
              ],
            }),
          );
        } else if (block.type === 'text' && block.text) {
          emit(openAIChunk({ content: block.text }));
        } else if (block.type === 'thinking' && block.thinking) {
          emit(openAIChunk({ reasoning_content: block.thinking }));
        }
        return;
      }
      if (type === 'content_block_delta') {
        const delta = event.delta || {};
        if (delta.type === 'text_delta' && delta.text) emit(openAIChunk({ content: delta.text }));
        else if (delta.type === 'thinking_delta' && delta.thinking) {
          emit(openAIChunk({ reasoning_content: delta.thinking }));
        } else if (delta.type === 'input_json_delta' && delta.partial_json) {
          const index = toolIndexByBlock.get(event.index) ?? 0;
          emit(openAIChunk({ tool_calls: [{ index, function: { arguments: delta.partial_json } }] }));
        }
        return;
      }
      if (type === 'message_delta') {
        if (event.delta?.stop_reason) finishReason = mapStopReason(event.delta.stop_reason);
        if (event.usage?.output_tokens != null) outputTokens = Number(event.usage.output_tokens) || 0;
        return;
      }
      if (type === 'message_stop') {
        finish(emit);
        return;
      }
      if (type === 'error') {
        throw new Error(event.error?.message || 'Anthropic stream error');
      }
    },
    onEnd(emit) {
      finish(emit);
    },
  };
}

export async function chat(req, ctx) {
  if (!ctx?.baseUrl) {
    return errorResponse('Provider baseUrl is not configured', {
      status: 400,
      type: 'invalid_request_error',
      code: 'missing_base_url',
    });
  }
  if (!hasCredential(ctx)) {
    return errorResponse(`Missing API key for provider ${ctx.provider || 'anthropic'}`, {
      status: 401,
      type: 'authentication_error',
      code: 'missing_api_key',
    });
  }

  const extra = ctx.extraConfig && typeof ctx.extraConfig === 'object' ? ctx.extraConfig : {};
  const { system, messages } = translateMessages(req?.messages);
  if (messages.length === 0) {
    return errorResponse('At least one non-system message is required', {
      status: 400,
      type: 'invalid_request_error',
      code: 'invalid_messages',
    });
  }

  let maxTokens = resolveMaxTokens(req || {}, extra, ctx.modelInfo);
  const supportsThinking = ctx.modelInfo ? Boolean(ctx.modelInfo.reasoning) : true;
  const { thinking, maxTokens: nextMaxTokens } = buildThinking(
    supportsThinking ? req?.reasoning_effort : 'auto',
    maxTokens,
  );
  maxTokens = nextMaxTokens;

  const claudeCodeMode = isClaudeCode(ctx);
  const payload = { model: ctx.model, max_tokens: maxTokens, messages };
  let finalSystem = system;
  if (claudeCodeMode) {
    finalSystem = finalSystem ? `${CLAUDE_CODE_SYSTEM_INSTRUCTION}\n\n${finalSystem}` : CLAUDE_CODE_SYSTEM_INSTRUCTION;
  }
  if (finalSystem) payload.system = finalSystem;
  if (req?.temperature != null) payload.temperature = Number(req.temperature);
  if (req?.top_p != null) payload.top_p = Number(req.top_p);
  if (req?.stop != null) payload.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  if (thinking) {
    payload.thinking = thinking;
    payload.temperature = 1;
    delete payload.top_p;
  }
  const tools = translateTools(req?.tools);
  if (tools.length) {
    payload.tools = tools;
    const choice = translateToolChoice(req?.tool_choice);
    if (choice) payload.tool_choice = choice;
  }
  if (req?.stream) payload.stream = true;
  if (extra.body && typeof extra.body === 'object' && !Array.isArray(extra.body)) {
    Object.assign(payload, extra.body);
  }
  payload.model = ctx.model;
  payload.messages = messages;
  payload.stream = Boolean(req?.stream);
  if (thinking) payload.temperature = 1;

  let upstream;
  try {
    const doFetch = ctx.fetchImpl || fetch;
    upstream = await doFetch(messagesUrl(ctx.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': extra.anthropicVersion || ANTHROPIC_VERSION,
        ...(claudeCodeMode
          ? {
              'User-Agent': `claude-cli/${extra.claudeCodeVersion || DEFAULT_CLAUDE_CODE_VERSION} (external, cli)`,
              'anthropic-beta': extra.anthropicBeta || CLAUDE_CODE_BETAS,
              ...(ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey.replace(/^oauth:/, '').trim()}` } : {}),
            }
          : authHeaders(ctx, 'x-api-key')),
        ...(ctx.headers || {}),
      },
      body: JSON.stringify(payload),
      signal: ctx.signal,
    });
  } catch (error) {
    return networkError(error, 'Anthropic request');
  }

  if (!upstream.ok) return upstreamErrorResponse(upstream);
  if (payload.stream) return sseResponse(upstream, createStreamHandler(ctx.model));
  let json;
  try {
    json = await upstream.json();
  } catch (error) {
    return errorResponse(`Invalid Anthropic response: ${error?.message || error}`, {
      status: 502,
      type: 'upstream_error',
      code: 'invalid_response',
    });
  }
  return new Response(JSON.stringify(translateCompletion(json, ctx.model)), {
    status: 200,
    headers: JSON_HEADERS,
  });
}

export async function listModels(ctx) {
  const base = trimSlash(ctx?.baseUrl || 'https://api.anthropic.com');
  const url = /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
  const claudeCodeMode = isClaudeCode(ctx);
  const headers = {
    'anthropic-version': ctx?.extraConfig?.anthropicVersion || ANTHROPIC_VERSION,
    ...(claudeCodeMode
      ? {
          'User-Agent': `claude-cli/${ctx?.extraConfig?.claudeCodeVersion || DEFAULT_CLAUDE_CODE_VERSION} (external, cli)`,
          'anthropic-beta': ctx?.extraConfig?.anthropicBeta || CLAUDE_CODE_BETAS,
          ...(ctx?.apiKey ? { Authorization: `Bearer ${ctx.apiKey.replace(/^oauth:/, '').trim()}` } : {}),
        }
      : authHeaders(ctx, 'x-api-key')),
    ...(ctx?.headers || {}),
  };
  const doFetch = ctx?.fetchImpl || fetch;
  const response = await doFetch(url, { headers, signal: ctx?.signal });
  if (!response.ok) {
    throw new Error(`Anthropic listModels failed: HTTP ${response.status}`);
  }
  const data = await response.json();
  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  return list.map((item) => ({
    id: item.id,
    name: item.display_name || item.id,
  }));
}

export { translateCompletion, createStreamHandler };

export default { id, chat, listModels };
