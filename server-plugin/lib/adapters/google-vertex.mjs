/** Google Vertex AI gateway adapter (Gemini publisher models). */
import { createHash, createSign } from 'node:crypto';
import {
  JSON_HEADERS,
  errorResponse,
  networkError,
  sseResponse,
  trimSlash,
  upstreamErrorResponse,
} from './openai.mjs';
import {
  buildGoogleBody,
  createGoogleStreamHandler,
  translateGoogleCompletion,
} from './google.mjs';

export const id = 'google-vertex';

const DEFAULT_REGION = 'us-central1';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const tokenCache = new Map();

function base64url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function parseServiceAccount(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function mintAccessToken(account, doFetch, signal) {
  const cacheKey = `${account.client_email || ''}:${createHash('sha256')
    .update(String(account.private_key || ''))
    .digest('hex')
    .slice(0, 16)}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return { token: cached.token };

  if (!account.client_email || !account.private_key) {
    return { error: 'Service account JSON must include client_email and private_key' };
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: SCOPE,
      aud: TOKEN_ENDPOINT,
      iat: now,
      exp: now + 3600,
    }),
  );
  let signature;
  try {
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    signer.end();
    signature = signer.sign(account.private_key).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  } catch (error) {
    return { error: `Failed to sign service account JWT: ${error?.message || error}` };
  }

  let response;
  try {
    response = await doFetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${claims}.${signature}`,
      }).toString(),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') return { aborted: true };
    return { error: `Token request failed: ${error?.message || error}` };
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = await response.text();
    } catch {
      detail = '';
    }
    return { error: `Token request failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ''}` };
  }

  let json;
  try {
    json = await response.json();
  } catch {
    return { error: 'Token endpoint returned invalid JSON' };
  }
  const token = json?.access_token;
  if (!token) return { error: 'Token endpoint returned no access_token' };
  const expiresIn = Number(json.expires_in) || 3600;
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1000 });
  return { token };
}

async function resolveAccessToken(ctx, doFetch) {
  const extra = ctx.extraConfig && typeof ctx.extraConfig === 'object' ? ctx.extraConfig : {};
  if (extra.accessToken) return { token: extra.accessToken };
  if (ctx.apiKey) return { token: ctx.apiKey };
  const account = parseServiceAccount(extra.serviceAccountJson);
  if (!account) return { error: 'Google Vertex credentials are not configured' };
  return mintAccessToken(account, doFetch, ctx.signal);
}

function vertexUrl(ctx, model, stream, projectId) {
  const extra = ctx.extraConfig && typeof ctx.extraConfig === 'object' ? ctx.extraConfig : {};
  const region = extra.region || DEFAULT_REGION;
  let base = trimSlash(ctx.baseUrl || `https://${region}-aiplatform.googleapis.com`)
    .replace(/\{region\}/g, region)
    .replace(/\{location\}/g, region);
  base = base.replace(/\/v1$/, '');
  const action = stream ? 'streamGenerateContent' : 'generateContent';
  const query = stream ? '?alt=sse' : '';
  return `${base}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(
    region,
  )}/publishers/google/models/${encodeURIComponent(model)}:${action}${query}`;
}

export async function chat(req, ctx) {
  if (!ctx?.baseUrl && !ctx?.extraConfig?.region) {
    return errorResponse('Provider baseUrl is not configured', {
      status: 400,
      type: 'invalid_request_error',
      code: 'missing_base_url',
    });
  }
  const extra = ctx.extraConfig && typeof ctx.extraConfig === 'object' ? ctx.extraConfig : {};
  const account = parseServiceAccount(extra.serviceAccountJson);
  const projectId = extra.projectId || account?.project_id;
  if (!projectId) {
    return errorResponse('Google Vertex requires extraConfig.projectId', {
      status: 400,
      type: 'invalid_request_error',
      code: 'missing_project_id',
    });
  }

  const doFetch = ctx.fetchImpl || fetch;
  const credentials = await resolveAccessToken(ctx, doFetch);
  if (credentials.aborted) {
    return errorResponse('Google Vertex token request aborted', {
      status: 499,
      type: 'aborted',
      code: 'aborted',
    });
  }
  if (!credentials.token) {
    return errorResponse(credentials.error || 'Google Vertex credentials are not configured', {
      status: 401,
      type: 'authentication_error',
      code: 'missing_credentials',
    });
  }

  const payload = buildGoogleBody(req, ctx);
  if (payload.error) {
    return errorResponse(payload.error, {
      status: 400,
      type: 'invalid_request_error',
      code: 'invalid_messages',
    });
  }

  const model = String(ctx.model || '').replace(/^models\//, '');
  const stream = Boolean(req?.stream);
  const url = vertexUrl(ctx, model, stream, projectId);

  let upstream;
  try {
    upstream = await doFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credentials.token}`,
        ...(ctx.headers && typeof ctx.headers === 'object' ? ctx.headers : {}),
      },
      body: JSON.stringify(payload),
      signal: ctx.signal,
    });
  } catch (error) {
    return networkError(error, 'Google Vertex request');
  }

  if (!upstream.ok) return upstreamErrorResponse(upstream);
  if (stream) return sseResponse(upstream, createGoogleStreamHandler(model));
  let json;
  try {
    json = await upstream.json();
  } catch (error) {
    return errorResponse(`Invalid Google Vertex response: ${error?.message || error}`, {
      status: 502,
      type: 'upstream_error',
      code: 'invalid_response',
    });
  }
  return new Response(JSON.stringify(translateGoogleCompletion(json, model)), {
    status: 200,
    headers: JSON_HEADERS,
  });
}

export default { id, chat };
