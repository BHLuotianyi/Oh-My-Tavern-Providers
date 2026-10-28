/** Azure OpenAI Responses API gateway adapter. */
import {
  hasCredential,
  invalidMessages,
  missingApiKey,
  missingBaseUrl,
  runJsonAdapter,
  trimSlash,
} from './openai.mjs';
import {
  buildResponsesBody,
  createResponsesStreamHandler,
  translateResponsesCompletion,
} from './responses.mjs';

export const id = 'azure-responses';

const DEFAULT_API_VERSION = '2025-04-01-preview';

function responsesUrl(ctx) {
  const extra = ctx.extraConfig && typeof ctx.extraConfig === 'object' ? ctx.extraConfig : {};
  const deployment = extra.deployment || ctx.model;
  const apiVersion = extra.apiVersion || DEFAULT_API_VERSION;
  let base = trimSlash(ctx.baseUrl);
  if (/\/openai$/.test(base)) base = base.slice(0, -'/openai'.length);
  return `${base}/openai/deployments/${encodeURIComponent(deployment)}/responses?api-version=${encodeURIComponent(
    apiVersion,
  )}`;
}

export async function chat(req, ctx) {
  if (!ctx?.baseUrl) return missingBaseUrl();
  if (!hasCredential(ctx)) return missingApiKey(ctx, 'azure');

  const payload = buildResponsesBody(req, ctx);
  if (payload.error) return invalidMessages();

  const headers = { 'Content-Type': 'application/json' };
  if (ctx.apiKey) headers['api-key'] = ctx.apiKey;
  if (ctx.headers && typeof ctx.headers === 'object') Object.assign(headers, ctx.headers);

  return runJsonAdapter({
    url: responsesUrl(ctx),
    headers,
    payload,
    label: 'Azure Responses',
    invalidLabel: 'Azure Responses API response',
    stream: payload.stream,
    streamHandler: () => createResponsesStreamHandler(ctx.model),
    translate: (json) => translateResponsesCompletion(json, ctx.model),
    ctx,
  });
}

export default { id, chat };
