/** OpenAI Responses API gateway adapter. */
import {
  JSON_HEADERS,
  authHeaders,
  contentToText,
  errorResponse,
  hasCredential,
  networkError,
  newCompletionId,
  resolveBaseUrl,
  sseResponse,
  trimSlash,
  upstreamErrorResponse,
  usageFrame,
  openAIUsage,
} from './openai.mjs';
import { openAIChunk } from '../sse.mjs';

export const id = 'responses';

const EFFORT_MAP = { min: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'high' };

function translateInput(messages) {
  const instructions = [];
  const input = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    const role = message.role;
    if (role === 'system' || role === 'developer') {
      const text = contentToText(message.content);
      if (text) instructions.push(text);
      continue;
    }
    if (role === 'tool' || role === 'function') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id || message.name || '',
        output: contentToText(message.content),
      });
      continue;
    }
    if (role === 'assistant') {
      const text = contentToText(message.content);
      if (text) {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      }
      for (const call of message.tool_calls || []) {
        const fn = call.function || call;
        input.push({
          type: 'function_call',
          call_id: call.id || `call_${input.length}`,
          name: fn.name || call.name || 'tool',
          arguments:
            typeof fn.arguments === 'string'
              ? fn.arguments
              : JSON.stringify(fn.arguments ?? call.arguments ?? {}),
        });
      }
      continue;
    }
    const parts = [];
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (typeof part === 'string') parts.push({ type: 'input_text', text: part });
        else if (part?.type === 'text' && typeof part.text === 'string') {
          parts.push({ type: 'input_text', text: part.text });
        } else if (part?.type === 'image_url' || part?.type === 'image') {
          const url = part.image_url?.url || part.image_url || part.url;
          if (url) parts.push({ type: 'input_image', image_url: url });
        }
      }
    } else {
      const text = contentToText(message.content);
      if (text) parts.push({ type: 'input_text', text });
    }
    if (parts.length) input.push({ type: 'message', role: 'user', content: parts });
  }
  return { instructions: instructions.join('\n\n'), input };
}

function translateTools(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const tool of tools) {
    const fn = tool?.function || tool;
    if (!fn?.name) continue;
    const entry = { type: 'function', name: fn.name };
    if (fn.description) entry.description = fn.description;
    entry.parameters =
      fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} };
    out.push(entry);
  }
  return out;
}

function translateToolChoice(choice) {
  if (!choice) return undefined;
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  if (typeof choice === 'object') {
    const name = choice.function?.name || choice.name;
    if (name) return { type: 'function', name };
  }
  return undefined;
}

export function buildResponsesBody(req, ctx) {
  const extra = ctx?.extraConfig && typeof ctx.extraConfig === 'object' ? ctx.extraConfig : {};
  const { instructions, input } = translateInput(req?.messages);
  if (input.length === 0) return { error: 'At least one non-system message is required' };

  const payload = { model: ctx?.model, input };
  if (instructions) payload.instructions = instructions;
  const maxOutput = req?.max_output_tokens ?? req?.max_completion_tokens ?? req?.max_tokens ?? extra.maxTokens;
  if (maxOutput != null && Number.isFinite(Number(maxOutput))) {
    payload.max_output_tokens = Math.floor(Number(maxOutput));
  }
  if (req?.temperature != null) payload.temperature = Number(req.temperature);
  if (req?.top_p != null) payload.top_p = Number(req.top_p);
  payload.stream = Boolean(req?.stream);

  const tools = translateTools(req?.tools);
  if (tools.length) {
    payload.tools = tools;
    const choice = translateToolChoice(req?.tool_choice);
    if (choice) payload.tool_choice = choice;
  }

  const supportsReasoning = ctx?.modelInfo ? Boolean(ctx.modelInfo.reasoning) : true;
  const effort = supportsReasoning ? EFFORT_MAP[req?.reasoning_effort] : undefined;
  if (effort) payload.reasoning = { effort };

  if (extra.body && typeof extra.body === 'object' && !Array.isArray(extra.body)) {
    Object.assign(payload, extra.body);
  }
  payload.model = ctx?.model;
  payload.input = input;
  payload.stream = Boolean(req?.stream);
  return payload;
}

export function translateResponsesCompletion(json, model) {
  const output = Array.isArray(json?.output) ? json.output : [];
  let text = '';
  let reasoning = '';
  const toolCalls = [];
  for (const item of output) {
    if (item?.type === 'message') {
      for (const content of item.content || []) {
        if (content?.type === 'output_text' && typeof content.text === 'string') text += content.text;
        else if (content?.type === 'refusal' && typeof content.refusal === 'string') text += content.refusal;
      }
    } else if (item?.type === 'reasoning') {
      for (const summary of item.summary || []) {
        if (typeof summary?.text === 'string') reasoning += summary.text;
      }
    } else if (item?.type === 'function_call') {
      toolCalls.push({
        id: item.call_id || item.id || `call_${toolCalls.length}`,
        type: 'function',
        function: { name: item.name, arguments: item.arguments || '{}' },
      });
    }
  }
  const message = { role: 'assistant', content: text || (toolCalls.length ? null : '') };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;

  const usage = json?.usage || {};
  const promptTokens = Number(usage.input_tokens) || 0;
  const completionTokens = Number(usage.output_tokens) || 0;
  const totalTokens = Number(usage.total_tokens) || promptTokens + completionTokens;
  // The Responses API reports cached input nested under `input_tokens_details`.
  const cachedTokens = Number(usage.input_tokens_details?.cached_tokens) || 0;
  const reasoningTokens = Number(usage.output_tokens_details?.reasoning_tokens) || 0;

  let finishReason = 'stop';
  if (toolCalls.length) finishReason = 'tool_calls';
  else if (json?.status === 'incomplete' && json?.incomplete_details?.reason === 'max_output_tokens') {
    finishReason = 'length';
  } else if (json?.status === 'incomplete') finishReason = 'content_filter';

  return {
    id: json?.id || newCompletionId(),
    object: 'chat.completion',
    created: Number(json?.created_at) || Math.floor(Date.now() / 1000),
    model: json?.model || model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: openAIUsage({
      prompt: promptTokens,
      completion: completionTokens,
      cached: cachedTokens,
      reasoning: reasoningTokens,
      total: totalTokens,
    }),
  };
}

export function createResponsesStreamHandler(model) {
  const toolIndexByItem = new Map();
  let toolIndex = 0;
  let sawTool = false;
  let finishReason = null;
  let usage = null;
  let finished = false;

  const finish = (emit) => {
    if (finished) return;
    finished = true;
    emit(openAIChunk({}, finishReason || (sawTool ? 'tool_calls' : 'stop')));
    if (usage) emit(usageFrame(usage, model));
  };

  return {
    onStart(emit) {
      emit(openAIChunk({ role: 'assistant', content: '' }));
    },
    onEvent(event, emit) {
      const type = event?.type;
      if (type === 'response.output_item.added') {
        const item = event.item || {};
        if (item.type === 'function_call') {
          const index = toolIndex++;
          sawTool = true;
          toolIndexByItem.set(item.id || item.call_id, index);
          emit(
            openAIChunk({
              tool_calls: [
                {
                  index,
                  id: item.call_id || item.id || `call_${index}`,
                  type: 'function',
                  function: { name: item.name, arguments: '' },
                },
              ],
            }),
          );
        }
        return;
      }
      if (type === 'response.output_text.delta') {
        if (typeof event.delta === 'string' && event.delta) emit(openAIChunk({ content: event.delta }));
        return;
      }
      if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
        if (typeof event.delta === 'string' && event.delta) {
          emit(openAIChunk({ reasoning_content: event.delta }));
        }
        return;
      }
      if (type === 'response.function_call_arguments.delta') {
        const index = toolIndexByItem.get(event.item_id) ?? 0;
        if (typeof event.delta === 'string' && event.delta) {
          emit(openAIChunk({ tool_calls: [{ index, function: { arguments: event.delta } }] }));
        }
        return;
      }
      if (type === 'response.completed') {
        const response = event.response || {};
        const usageInfo = response.usage || {};
        const prompt = Number(usageInfo.input_tokens) || 0;
        const completion = Number(usageInfo.output_tokens) || 0;
        usage = {
          prompt_tokens: prompt,
          completion_tokens: completion,
          total_tokens: Number(usageInfo.total_tokens) || prompt + completion,
        };
        finishReason = sawTool ? 'tool_calls' : 'stop';
        return;
      }
      if (type === 'response.incomplete') {
        const reason = event.response?.incomplete_details?.reason;
        finishReason = reason === 'max_output_tokens' ? 'length' : 'content_filter';
        return;
      }
      if (type === 'response.failed' || type === 'response.error' || type === 'error') {
        const message =
          event.response?.error?.message || event.error?.message || event.message || 'Responses API error';
        throw new Error(message);
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
    return errorResponse(`Missing API key for provider ${ctx.provider || 'responses'}`, {
      status: 401,
      type: 'authentication_error',
      code: 'missing_api_key',
    });
  }

  const payload = buildResponsesBody(req, ctx);
  if (payload.error) {
    return errorResponse(payload.error, {
      status: 400,
      type: 'invalid_request_error',
      code: 'invalid_messages',
    });
  }

  const doFetch = ctx.fetchImpl || fetch;
  const url = `${trimSlash(resolveBaseUrl(ctx.baseUrl, ctx.extraConfig || {}))}/responses`;
  let upstream;
  try {
    upstream = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(ctx) },
      body: JSON.stringify(payload),
      signal: ctx.signal,
    });
  } catch (error) {
    return networkError(error, 'Responses request');
  }

  if (!upstream.ok) return upstreamErrorResponse(upstream);
  if (payload.stream) return sseResponse(upstream, createResponsesStreamHandler(ctx.model));
  let json;
  try {
    json = await upstream.json();
  } catch (error) {
    return errorResponse(`Invalid Responses API response: ${error?.message || error}`, {
      status: 502,
      type: 'upstream_error',
      code: 'invalid_response',
    });
  }
  return new Response(JSON.stringify(translateResponsesCompletion(json, ctx.model)), {
    status: 200,
    headers: JSON_HEADERS,
  });
}

export default { id, chat };
