/** Amazon Bedrock (Converse API) gateway adapter with SigV4 signing. */
import { createHash, createHmac } from 'node:crypto';
import {
  JSON_HEADERS,
  contentToText,
  errorResponse,
  invalidMessages,
  invalidResponse,
  networkError,
  newCompletionId,
  openAIUsage,
  parseDataUrl,
  parseJsonObject,
  pushContent,
  trimSlash,
  upstreamErrorResponse,
  usageFrame,
} from './openai.mjs';
import { openAIChunk, done, sseHeaders } from '../sse.mjs';

export const id = 'bedrock';

const DEFAULT_REGION = 'us-east-1';
const SERVICE = 'bedrock';

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key, value) {
  return createHmac('sha256', key).update(value).digest();
}

function amzDate() {
  return new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function signRequest({ url, body, region, accessKeyId, secretAccessKey, sessionToken }) {
  const parsed = new URL(url);
  const timestamp = amzDate();
  const dateStamp = timestamp.slice(0, 8);
  const payloadHash = sha256Hex(body);

  const canonical = {
    host: parsed.host,
    'content-type': 'application/json',
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': timestamp,
  };
  if (sessionToken) canonical['x-amz-security-token'] = sessionToken;

  const names = Object.keys(canonical).sort();
  const canonicalHeaders = names.map((name) => `${name}:${canonical[name]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    'POST',
    parsed.pathname || '/',
    parsed.searchParams.toString(),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', timestamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), SERVICE),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const headers = {
    'Content-Type': 'application/json',
    'X-Amz-Date': timestamp,
    'X-Amz-Content-Sha256': payloadHash,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (sessionToken) headers['X-Amz-Security-Token'] = sessionToken;
  return headers;
}

function imageBlock(part) {
  const url = part?.image_url?.url || part?.image_url || part?.url;
  const parsed = parseDataUrl(url);
  if (!parsed) return null;
  const mime = parsed.mimeType.toLowerCase();
  let format = 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) format = 'jpeg';
  else if (mime.includes('gif')) format = 'gif';
  else if (mime.includes('webp')) format = 'webp';
  return { image: { format, source: { bytes: parsed.data } } };
}

/** Split OpenAI messages into Converse `system` blocks and merged turns. */
function convertMessages(messages) {
  const system = [];
  const turns = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    const role = message.role;
    if (role === 'system' || role === 'developer') {
      const text = contentToText(message.content);
      if (text) system.push({ text });
      continue;
    }
    if (role === 'tool' || role === 'function') {
      pushContent(turns, 'user', [
        {
          toolResult: {
            toolUseId: message.tool_call_id || message.name || '',
            content: [{ text: contentToText(message.content) }],
            status: 'success',
          },
        },
      ]);
      continue;
    }
    if (role === 'assistant') {
      const blocks = [];
      const text = contentToText(message.content);
      if (text) blocks.push({ text });
      for (const call of message.tool_calls || []) {
        const fn = call.function || call;
        blocks.push({
          toolUse: {
            toolUseId: call.id || `call_${blocks.length}`,
            name: fn.name || call.name || 'tool',
            input: parseJsonObject(fn.arguments ?? call.arguments),
          },
        });
      }
      if (blocks.length) pushContent(turns, 'assistant', blocks);
      continue;
    }
    const blocks = [];
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (typeof part === 'string') blocks.push({ text: part });
        else if (part?.type === 'text' && typeof part.text === 'string') blocks.push({ text: part.text });
        else if (part?.type === 'image_url' || part?.type === 'image') {
          const block = imageBlock(part);
          if (block) blocks.push(block);
        }
      }
    } else {
      const text = contentToText(message.content);
      if (text) blocks.push({ text });
    }
    if (blocks.length) pushContent(turns, 'user', blocks);
  }

  // Converse requires the transcript to start with a user turn.
  if (turns.length && turns[0].role !== 'user') {
    turns.unshift({ role: 'user', content: [{ text: ' ' }] });
  }
  return { system, turns };
}

function buildInferenceConfig(req, extra) {
  const config = {};
  const maxTokens = req?.max_completion_tokens ?? req?.max_tokens ?? extra.maxTokens;
  if (maxTokens != null && Number.isFinite(Number(maxTokens))) {
    config.maxTokens = Math.floor(Number(maxTokens));
  }
  if (req?.temperature != null && Number.isFinite(Number(req.temperature))) {
    config.temperature = Math.min(1, Math.max(0, Number(req.temperature)));
  }
  if (req?.top_p != null && Number.isFinite(Number(req.top_p))) {
    config.topP = Math.min(1, Math.max(0, Number(req.top_p)));
  }
  if (req?.stop != null) {
    const stop = (Array.isArray(req.stop) ? req.stop : [req.stop]).filter(Boolean).slice(0, 4);
    if (stop.length) config.stopSequences = stop;
  }
  return config;
}

function buildToolConfig(req) {
  if (!Array.isArray(req?.tools) || !req.tools.length || req.tool_choice === 'none') return null;
  const tools = [];
  for (const tool of req.tools) {
    const fn = tool?.function || tool;
    if (!fn?.name) continue;
    const toolSpec = { name: fn.name };
    if (fn.description) toolSpec.description = fn.description;
    toolSpec.inputSchema = {
      json:
        fn.parameters && typeof fn.parameters === 'object'
          ? fn.parameters
          : { type: 'object', properties: {} },
    };
    tools.push({ toolSpec });
  }
  if (!tools.length) return null;
  const toolConfig = { tools };
  if (req.tool_choice === 'required' || req.tool_choice === 'any') toolConfig.toolChoice = { any: {} };
  else if (typeof req.tool_choice === 'object') {
    const name = req.tool_choice.function?.name || req.tool_choice.name;
    if (name) toolConfig.toolChoice = { tool: { name } };
  }
  return toolConfig;
}

function buildConverse(req, ctx) {
  const extra = ctx?.extraConfig && typeof ctx.extraConfig === 'object' ? ctx.extraConfig : {};
  const { system, turns } = convertMessages(req?.messages);
  const body = { messages: turns };
  if (system.length) body.system = system;
  const inferenceConfig = buildInferenceConfig(req, extra);
  if (Object.keys(inferenceConfig).length) body.inferenceConfig = inferenceConfig;
  const toolConfig = buildToolConfig(req);
  if (toolConfig) body.toolConfig = toolConfig;
  if (extra.body && typeof extra.body === 'object' && !Array.isArray(extra.body)) {
    Object.assign(body, extra.body);
  }
  body.messages = turns;
  return body;
}

function mapStopReason(reason, sawTool) {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return sawTool ? 'tool_calls' : 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'guardrail_intervened':
    case 'content_filtered':
      return 'content_filter';
    default:
      return sawTool ? 'tool_calls' : 'stop';
  }
}

function translateConverse(json, model) {
  const content = json?.output?.message?.content || [];
  let text = '';
  let reasoning = '';
  const toolCalls = [];
  for (const block of content) {
    if (typeof block?.text === 'string') text += block.text;
    else if (block?.reasoningContent?.reasoningText?.text) {
      reasoning += block.reasoningContent.reasoningText.text;
    } else if (block?.toolUse) {
      toolCalls.push({
        id: block.toolUse.toolUseId || `call_${toolCalls.length}`,
        type: 'function',
        function: {
          name: block.toolUse.name,
          arguments: JSON.stringify(block.toolUse.input ?? {}),
        },
      });
    }
  }
  const message = { role: 'assistant', content: text || (toolCalls.length ? null : '') };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;

  const usage = json?.usage || {};
  const cacheRead = Number(usage.cacheReadInputTokens) || 0;
  const cacheWrite = Number(usage.cacheWriteInputTokens) || 0;
  const promptTokens = (Number(usage.inputTokens) || 0) + cacheRead + cacheWrite;
  const completionTokens = Number(usage.outputTokens) || 0;
  const totalTokens = Number(usage.totalTokens) || promptTokens + completionTokens;

  return {
    id: newCompletionId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapStopReason(json?.stopReason, toolCalls.length > 0),
      },
    ],
    usage: openAIUsage({
      prompt: promptTokens,
      completion: completionTokens,
      cached: cacheRead,
      cacheWrite,
      total: totalTokens,
    }),
  };
}

function synthesizeSse(completion) {
  const frames = [openAIChunk({ role: 'assistant', content: '' })];
  const message = completion.choices[0].message;
  if (message.reasoning_content) frames.push(openAIChunk({ reasoning_content: message.reasoning_content }));
  if (message.content) frames.push(openAIChunk({ content: message.content }));
  for (const [index, call] of (message.tool_calls || []).entries()) {
    frames.push(
      openAIChunk({
        tool_calls: [
          { index, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } },
        ],
      }),
    );
    frames.push(
      openAIChunk({ tool_calls: [{ index, function: { arguments: call.function.arguments } }] }),
    );
  }
  frames.push(openAIChunk({}, completion.choices[0].finish_reason));
  frames.push(usageFrame(completion.usage, completion.model));
  frames.push(done());
  return frames.join('');
}

export async function chat(req, ctx) {
  const extra = ctx?.extraConfig && typeof ctx.extraConfig === 'object' ? ctx.extraConfig : {};
  const region = extra.region || DEFAULT_REGION;
  const accessKeyId = extra.accessKeyId || extra.awsAccessKeyId;
  const secretAccessKey = extra.secretAccessKey || extra.awsSecretAccessKey;
  const sessionToken = extra.sessionToken || extra.awsSessionToken;

  if (!accessKeyId || !secretAccessKey) {
    return errorResponse('AWS credentials required', {
      status: 401,
      type: 'authentication_error',
      code: 'missing_credentials',
    });
  }

  const body = buildConverse(req, ctx);
  if (!body.messages?.length) return invalidMessages();

  const base = trimSlash(ctx.baseUrl || '').replace('{region}', region);
  const url =
    base && /amazonaws\.com/.test(base)
      ? `${base}/model/${encodeURIComponent(ctx.model)}/converse`
      : `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(ctx.model)}/converse`;
  const serialized = JSON.stringify(body);
  const headers = signRequest({
    url,
    body: serialized,
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken,
  });

  const doFetch = ctx.fetchImpl || fetch;
  let upstream;
  try {
    upstream = await doFetch(url, {
      method: 'POST',
      headers,
      body: serialized,
      signal: ctx.signal,
    });
  } catch (error) {
    return networkError(error, 'Bedrock request');
  }

  if (!upstream.ok) return upstreamErrorResponse(upstream);
  let json;
  try {
    json = await upstream.json();
  } catch (error) {
    return invalidResponse('Bedrock response', error);
  }

  const completion = translateConverse(json, ctx.model);
  if (req?.stream) {
    return new Response(synthesizeSse(completion), { status: 200, headers: sseHeaders() });
  }
  return new Response(JSON.stringify(completion), { status: 200, headers: JSON_HEADERS });
}

export default { id, chat };
