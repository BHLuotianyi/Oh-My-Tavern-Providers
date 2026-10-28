/** Azure OpenAI Responses API gateway adapter. */
import {
  JSON_HEADERS,
  errorResponse,
  hasCredential,
  networkError,
  sseResponse,
  trimSlash,
  upstreamErrorResponse,
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
  if (!ctx?.baseUrl) {
    return errorResponse('Provider baseUrl is not configured', {
      status: 400,
      type: 'invalid_request_error',
      code: 'missing_base_url',
    });
  }
  if (!hasCredential(ctx)) {
    return errorResponse(`Missing API key for provider ${ctx.provider || 'azure'}`, {
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

  const headers = { 'Content-Type': 'application/json' };
  if (ctx.apiKey) headers['api-key'] = ctx.apiKey;
  if (ctx.headers && typeof ctx.headers === 'object') Object.assign(headers, ctx.headers);

  const doFetch = ctx.fetchImpl || fetch;
  let upstream;
  try {
    upstream = await doFetch(responsesUrl(ctx), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ctx.signal,
    });
  } catch (error) {
    return networkError(error, 'Azure Responses request');
  }

  if (!upstream.ok) return upstreamErrorResponse(upstream);
  if (payload.stream) return sseResponse(upstream, createResponsesStreamHandler(ctx.model));
  let json;
  try {
    json = await upstream.json();
  } catch (error) {
    return errorResponse(`Invalid Azure Responses API response: ${error?.message || error}`, {
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
