/** Google Generative Language (Gemini) gateway adapter. */
import {
  contentToText,
  createFinishEmitter,
  hasCredential,
  invalidMessages,
  missingApiKey,
  missingBaseUrl,
  newCompletionId,
  openAIUsage,
  parseDataUrl,
  parseJsonObject,
  pushContent,
  resolveBaseUrl,
  runJsonAdapter,
  trimSlash,
  usageFrame,
} from './openai.mjs';
import { openAIChunk } from '../sse.mjs';

export const id = 'google';

const THINKING_BUDGETS = { min: 1024, low: 2048, medium: 8192, high: 16384, max: 24576 };
const FINISH_REASONS = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
  BLOCKLIST: 'content_filter',
  PROHIBITED_CONTENT: 'content_filter',
  SPII: 'content_filter',
  MALFORMED_FUNCTION_CALL: 'tool_calls',
  OTHER: 'stop',
  FINISH_REASON_UNSPECIFIED: 'stop',
};

function googleRoot(baseUrl) {
  const base = trimSlash(baseUrl);
  if (/\/(v1beta|v1)$/.test(base)) return base;
  return `${base}/v1beta`;
}

function guessMime(url) {
  const clean = String(url || '').split('?')[0].toLowerCase();
  if (clean.endsWith('.png')) return 'image/png';
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg';
  if (clean.endsWith('.webp')) return 'image/webp';
  if (clean.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

function imagePart(url) {
  if (!url) return null;
  const parsed = parseDataUrl(url);
  if (parsed) return { inlineData: { mimeType: parsed.mimeType, data: parsed.data } };
  return { fileData: { fileUri: url, mimeType: guessMime(url) } };
}

function buildContents(messages) {
  const system = [];
  const contents = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    const role = message.role;
    if (role === 'system' || role === 'developer') {
      const text = contentToText(message.content);
      if (text) system.push(text);
      continue;
    }
    if (role === 'tool' || role === 'function') {
      pushContent(contents, 'user', [
        {
          functionResponse: {
            name: message.name || message.tool_call_id || 'tool',
            response: { content: contentToText(message.content) },
          },
        },
      ]);
      continue;
    }
    if (role === 'assistant') {
      const parts = [];
      const text = contentToText(message.content);
      if (text) parts.push({ text });
      for (const call of message.tool_calls || []) {
        const fn = call.function || call;
        parts.push({
          functionCall: {
            name: fn.name || call.name || 'tool',
            args: parseJsonObject(fn.arguments ?? call.arguments),
          },
        });
      }
      if (parts.length) pushContent(contents, 'model', parts);
      continue;
    }
    const parts = [];
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (typeof part === 'string') parts.push({ text: part });
        else if (part?.type === 'text' && typeof part.text === 'string') parts.push({ text: part.text });
        else if (part?.type === 'image_url' || part?.type === 'image') {
          const block = imagePart(part.image_url?.url || part.image_url || part.url);
          if (block) parts.push(block);
        }
      }
    } else {
      const text = contentToText(message.content);
      if (text) parts.push({ text });
    }
    if (parts.length) pushContent(contents, 'user', parts);
  }
  return { system: system.join('\n\n'), contents };
}

function translateTools(tools) {
  if (!Array.isArray(tools)) return [];
  const declarations = [];
  for (const tool of tools) {
    const fn = tool?.function || tool;
    if (!fn?.name) continue;
    const declaration = { name: fn.name };
    if (fn.description) declaration.description = fn.description;
    if (fn.parameters && typeof fn.parameters === 'object') declaration.parameters = fn.parameters;
    declarations.push(declaration);
  }
  return declarations.length ? [{ functionDeclarations: declarations }] : [];
}

function translateToolConfig(choice) {
  if (!choice) return undefined;
  if (choice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
  if (choice === 'required' || choice === 'any') return { functionCallingConfig: { mode: 'ANY' } };
  if (choice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
  if (typeof choice === 'object') {
    const name = choice.function?.name || choice.name;
    if (name) {
      return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [name] } };
    }
  }
  return undefined;
}

export function buildGoogleBody(req, ctx) {
  const extra = ctx?.extraConfig && typeof ctx.extraConfig === 'object' ? ctx.extraConfig : {};
  const { system, contents } = buildContents(req?.messages);
  if (contents.length === 0) return { error: 'At least one non-system message is required' };

  const generationConfig = {};
  const maxOutput = req?.max_completion_tokens ?? req?.max_tokens ?? extra.maxTokens;
  if (maxOutput != null && Number.isFinite(Number(maxOutput))) {
    generationConfig.maxOutputTokens = Math.floor(Number(maxOutput));
  }
  if (req?.temperature != null) generationConfig.temperature = Number(req.temperature);
  if (req?.top_p != null) generationConfig.topP = Number(req.top_p);
  if (req?.stop != null) generationConfig.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop];

  const effort = req?.reasoning_effort;
  const supportsThinking = ctx?.modelInfo ? Boolean(ctx.modelInfo.reasoning) : true;
  if (effort && effort !== 'auto' && extra.thinking !== false && supportsThinking) {
    const budget = THINKING_BUDGETS[effort];
    if (budget) generationConfig.thinkingConfig = { thinkingBudget: budget };
  }

  const payload = { contents };
  if (system) payload.systemInstruction = { parts: [{ text: system }] };
  if (Object.keys(generationConfig).length) payload.generationConfig = generationConfig;
  const tools = translateTools(req?.tools);
  if (tools.length) {
    payload.tools = tools;
    const toolConfig = translateToolConfig(req?.tool_choice);
    if (toolConfig) payload.toolConfig = toolConfig;
  }
  if (extra.body && typeof extra.body === 'object' && !Array.isArray(extra.body)) {
    Object.assign(payload, extra.body);
  }
  payload.contents = contents;
  return payload;
}

function mapGoogleFinish(reason, sawTool) {
  if (sawTool && (!reason || reason === 'STOP')) return 'tool_calls';
  return FINISH_REASONS[reason] || 'stop';
}

export function translateGoogleCompletion(json, model) {
  const candidate = json?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  let text = '';
  let reasoning = '';
  const toolCalls = [];
  for (const part of parts) {
    if (typeof part?.text === 'string') {
      if (part.thought) reasoning += part.text;
      else text += part.text;
    }
    if (part?.functionCall) {
      const index = toolCalls.length;
      toolCalls.push({
        id: `call_${index}`,
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      });
    }
  }
  const message = { role: 'assistant', content: text || (toolCalls.length ? null : '') };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;

  const usage = json?.usageMetadata || {};
  const promptTokens = Number(usage.promptTokenCount) || 0;
  const completionTokens = Number(usage.candidatesTokenCount) || 0;
  const totalTokens = Number(usage.totalTokenCount) || promptTokens + completionTokens;
  // Gemini reports cache hits and thinking separately; keep both for accounting.
  const openAI = openAIUsage({
    prompt: promptTokens,
    completion: completionTokens,
    cached: Number(usage.cachedContentTokenCount) || 0,
    reasoning: Number(usage.thoughtsTokenCount) || 0,
    total: totalTokens,
  });

  return {
    id: json?.responseId || newCompletionId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapGoogleFinish(candidate?.finishReason, toolCalls.length > 0),
      },
    ],
    usage: openAI,
  };
}

export function createGoogleStreamHandler(model) {
  let toolIndex = 0;
  let sawTool = false;
  let finishReason = null;
  let usage = null;

  const finish = createFinishEmitter(
    () => openAIChunk({}, mapGoogleFinish(finishReason, sawTool)),
    () => {
      if (!usage) return null;
      return usageFrame(openAIUsage({
        prompt: Number(usage.promptTokenCount) || 0,
        completion: Number(usage.candidatesTokenCount) || 0,
        cached: Number(usage.cachedContentTokenCount) || 0,
        reasoning: Number(usage.thoughtsTokenCount) || 0,
        total: Number(usage.totalTokenCount) || 0,
      }), model);
    },
  );

  return {
    onStart(emit) {
      emit(openAIChunk({ role: 'assistant', content: '' }));
    },
    onEvent(event, emit) {
      if (event?.error) throw new Error(event.error.message || 'Google stream error');
      const candidate = event?.candidates?.[0];
      if (candidate) {
        for (const part of candidate.content?.parts || []) {
          if (typeof part?.text === 'string' && part.text) {
            emit(openAIChunk(part.thought ? { reasoning_content: part.text } : { content: part.text }));
          }
          if (part?.functionCall) {
            const index = toolIndex++;
            sawTool = true;
            emit(
              openAIChunk({
                tool_calls: [
                  {
                    index,
                    id: `call_${index}`,
                    type: 'function',
                    function: {
                      name: part.functionCall.name,
                      arguments: JSON.stringify(part.functionCall.args ?? {}),
                    },
                  },
                ],
              }),
            );
          }
        }
        if (candidate.finishReason) finishReason = candidate.finishReason;
      }
      if (event?.usageMetadata) {
        // Keep the raw metadata; `finish` converts it once, including cache hits.
        usage = event.usageMetadata;
      }
      if (event?.promptFeedback?.blockReason) {
        throw new Error(`Google blocked the prompt: ${event.promptFeedback.blockReason}`);
      }
    },
    onEnd(emit) {
      finish(emit);
    },
  };
}

export async function chat(req, ctx) {
  if (!ctx?.baseUrl) return missingBaseUrl();
  if (!hasCredential(ctx)) return missingApiKey(ctx, 'google');

  const payload = buildGoogleBody(req, ctx);
  if (payload.error) return invalidMessages();

  const model = String(ctx.model || '').replace(/^models\//, '');
  const stream = Boolean(req?.stream);
  const action = stream ? 'streamGenerateContent' : 'generateContent';
  const params = new URLSearchParams();
  if (stream) params.set('alt', 'sse');
  if (ctx.apiKey) params.set('key', ctx.apiKey);
  const query = params.toString();
  const extra = ctx.extraConfig && typeof ctx.extraConfig === 'object' ? ctx.extraConfig : {};
  const url = `${googleRoot(resolveBaseUrl(ctx.baseUrl, extra))}/models/${encodeURIComponent(
    model,
  )}:${action}${query ? `?${query}` : ''}`;

  return runJsonAdapter({
    url,
    headers: {
      'Content-Type': 'application/json',
      ...(ctx.headers && typeof ctx.headers === 'object' ? ctx.headers : {}),
    },
    payload,
    label: 'Google',
    stream,
    streamHandler: () => createGoogleStreamHandler(model),
    translate: (json) => translateGoogleCompletion(json, model),
    ctx,
  });
}

export async function listModels(ctx) {
  const base = googleRoot(ctx?.baseUrl || 'https://generativelanguage.googleapis.com');
  const key = ctx?.apiKey ? `?key=${encodeURIComponent(ctx.apiKey)}` : '';
  const url = `${base}/models${key}`;
  const doFetch = ctx?.fetchImpl || fetch;
  const response = await doFetch(url, { signal: ctx?.signal });
  if (!response.ok) {
    throw new Error(`Google listModels failed: HTTP ${response.status}`);
  }
  const json = await response.json();
  const list = Array.isArray(json?.models) ? json.models : [];
  return list.map((item) => {
    const rawId = item.name || item.id || '';
    const cleanId = rawId.replace(/^models\//, '');
    return {
      id: cleanId,
      name: item.displayName || cleanId,
    };
  });
}

export default { id, chat, listModels };
