import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import openai from '../../server-plugin/lib/adapters/openai.mjs';
import anthropic from '../../server-plugin/lib/adapters/anthropic.mjs';
import antigravity from '../../server-plugin/lib/adapters/antigravity.mjs';
import { xxh64 } from '../../server-plugin/lib/claude-code-billing.mjs';
import { buildGatewayContext } from '../../server-plugin/lib/gateway-server.mjs';
import { buildProviderConfig } from '../../server-plugin/lib/provider-config.mjs';

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}/v1`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('openai adapter forwards JSON and returns an OpenAI response', async () => {
  let seen;
  await withServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ message: { role: 'assistant', content: 'pong' } }] }));
  }, async (baseUrl) => {
    const response = await openai.chat(
      { model: 'echo', messages: [{ role: 'user', content: 'ping' }], stream: false },
      { provider: 'mock', model: 'echo', baseUrl, apiKey: 'test', headers: {}, extraConfig: {} },
    );
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.choices[0].message.content, 'pong');
    assert.equal(seen.url, '/v1/chat/completions');
    assert.equal(seen.auth, 'Bearer test');
    assert.equal(seen.body.messages[0].content, 'ping');
  });
});

test('openai adapter passes through streaming SSE', async () => {
  let seenBody;
  await withServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seenBody = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"pong"}}]}\n\n');
    res.end('data: [DONE]\n\n');
  }, async (baseUrl) => {
    const response = await openai.chat(
      { model: 'echo', messages: [{ role: 'user', content: 'ping' }], stream: true },
      { provider: 'mock', model: 'echo', baseUrl, apiKey: 'test', headers: {}, extraConfig: {} },
    );
    assert.equal(seenBody.stream, true);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(await response.text(), 'data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n');
  });
});

test('providers declaring singleMaxTokens drop max_completion_tokens unless the switch is off', async () => {
  const sent = [];
  await withServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { max_tokens, max_completion_tokens } = JSON.parse(body);
    sent.push({ max_tokens, max_completion_tokens });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  }, async (baseUrl) => {
    const ark = { id: 'ark', gatewayAdapter: 'openai', baseUrl, singleMaxTokens: true, models: [] };
    const plain = { id: 'plain', gatewayAdapter: 'openai', baseUrl, models: [] };
    const cases = [
      [ark, {}, { max_tokens: 100, max_completion_tokens: 100 }],
      [ark, { singleMaxTokens: false }, { max_tokens: 100, max_completion_tokens: 100 }],
      [plain, {}, { max_tokens: 100, max_completion_tokens: 100 }],
      [ark, {}, { max_completion_tokens: 100 }],
    ];
    for (const [catalogProvider, stored, limits] of cases) {
      const resolved = buildProviderConfig(catalogProvider, { stored, apiKey: 'k' });
      const ctx = await buildGatewayContext(resolved, {}, 'm', null, catalogProvider);
      const response = await openai.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], ...limits }, ctx);
      assert.equal(response.status, 200);
    }
  });
  assert.deepEqual(sent, [
    { max_tokens: 100, max_completion_tokens: undefined },
    { max_tokens: 100, max_completion_tokens: 100 },
    { max_tokens: 100, max_completion_tokens: 100 },
    { max_tokens: undefined, max_completion_tokens: 100 },
  ]);
});

test('openai adapter reports missing credentials', async () => {
  const response = await openai.chat(
    { model: 'echo', messages: [] },
    { provider: 'mock', model: 'echo', baseUrl: 'https://example.invalid/v1', apiKey: '', headers: {}, extraConfig: {} },
  );
  assert.equal(response.status, 401);
});

test('openai adapter listModels returns models list', async () => {
  await withServer(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'gpt-4o', name: 'GPT-4o' }] }));
  }, async (baseUrl) => {
    const models = await openai.listModels({ baseUrl, apiKey: 'test' });
    assert.equal(models.length, 1);
    assert.equal(models[0].id, 'gpt-4o');
  });
});

test('anthropic adapter applies Claude Code fingerprint and system prompt', async () => {
  let capturedHeaders;
  let capturedBody;
  let rawBody = '';
  await withServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    capturedHeaders = req.headers;
    rawBody = body;
    capturedBody = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello from Claude Code' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
  }, async (baseUrl) => {
    const response = await anthropic.chat(
      { model: 'claude-3-7-sonnet', messages: [{ role: 'system', content: 'Roleplay rules' }, { role: 'user', content: 'hello there, assistant' }] },
      {
        provider: 'anthropic',
        model: 'claude-3-7-sonnet',
        baseUrl,
        apiKey: 'sk-ant-acc-oauth-token',
        extraConfig: { claudeCode: true },
      },
    );
    assert.equal(response.status, 200);
    assert.match(capturedHeaders['user-agent'], /claude-cli/);
    assert.match(capturedHeaders['anthropic-beta'], /claude-code-20250219/);
    assert.equal(capturedHeaders.authorization, 'Bearer sk-ant-acc-oauth-token');
    // Claude Code layout: billing attestation, identity, caller prompt. A single
    // folded string gets subscription requests rejected with 429 "Error".
    const [billing, identity, caller] = capturedBody.system;
    assert.match(billing.text, /^x-anthropic-billing-header: cc_version=\d+\.\d+\.\d+\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/);
    assert.match(identity.text, /^You are Claude Code/);
    assert.equal(caller.text, 'Roleplay rules');
    // cch is XXH64 of the body with the placeholder in place.
    const cch = /cch=([0-9a-f]{5})/.exec(billing.text)[1];
    const unpatched = Buffer.from(rawBody.replace(`cch=${cch}`, 'cch=00000'));
    assert.equal((xxh64(unpatched, 0x4d659218e32a3268n) & 0xfffffn).toString(16).padStart(5, '0'), cch);
  });
});

test('antigravity adapter builds CCA request envelope and parses response', async () => {
  let capturedEnvelope;
  let capturedHeaders;
  await withServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    capturedHeaders = req.headers;
    capturedEnvelope = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({
      response: {
        candidates: [{
          content: { parts: [{ text: 'Antigravity answer' }] },
          finishReason: 'STOP',
        }],
      },
    }) + '\n\n');
  }, async (baseUrl) => {
    const response = await antigravity.chat(
      { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'test antigravity' }] },
      {
        provider: 'google-antigravity',
        model: 'claude-sonnet-4-5',
        baseUrl,
        apiKey: 'oauth-token-123',
        extraConfig: { project: 'test-proj' },
      },
    );
    assert.equal(response.status, 200);
    assert.match(capturedHeaders['user-agent'], /antigravity\/hub/);
    assert.equal(capturedHeaders.authorization, 'Bearer oauth-token-123');
    assert.equal(capturedEnvelope.userAgent, 'antigravity');
    assert.equal(capturedEnvelope.project, 'test-proj');
    assert.equal(capturedEnvelope.request.labels.used_claude, 'true');
    const json = await response.json();
    assert.equal(json.choices[0].message.content, 'Antigravity answer');
  });
});

test('antigravity collapses effort-tier variants and requests the tier for the effort', async () => {
  const roster = {
    models: Object.fromEntries(['low', 'medium', 'high', 'xhigh'].map((tier) => [
      `gemini-4-hydrogen-${tier}`,
      { displayName: 'Gemini 4 Hydrogen', supportsThinking: true, maxTokens: 1048576 },
    ])),
  };
  const listed = await antigravity.listModels({
    provider: 'google-antigravity',
    apiKey: 'tok',
    fetchImpl: async () => new Response(JSON.stringify(roster), { status: 200 }),
  });
  assert.deepEqual(listed.map((model) => [model.id, model.efforts]), [
    ['gemini-4-hydrogen', ['low', 'medium', 'high', 'xhigh']],
  ]);

  const wireModels = [];
  await withServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    wireModels.push(JSON.parse(body).model);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] } }) + '\n\n');
  }, async (baseUrl) => {
    const cases = [['gemini-4-hydrogen', 'max'], ['gemini-4-hydrogen', 'medium'], ['gemini-4-hydrogen', undefined], ['gemini-4-argon', 'max']];
    for (const [model, effort] of cases) {
      const response = await antigravity.chat(
        { model, reasoning_effort: effort, messages: [{ role: 'user', content: 'hi' }] },
        { provider: 'google-antigravity', model, baseUrl, apiKey: 'tok', extraConfig: { project: 'p' } },
      );
      assert.equal(response.status, 200);
    }
  });
  assert.deepEqual(wireModels, ['gemini-4-hydrogen-xhigh', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-low', 'gemini-4-argon-high']);
});

test('antigravity adapter declares tools and round-trips tool calls', async () => {
  let capturedEnvelope;
  await withServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    capturedEnvelope = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({
      response: {
        candidates: [{
          content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] },
          finishReason: 'STOP',
        }],
      },
    }) + '\n\n');
  }, async (baseUrl) => {
    const response = await antigravity.chat(
      {
        model: 'claude-sonnet-4-5',
        messages: [
          { role: 'system', content: 'You are terse.' },
          { role: 'user', content: 'Weather in Paris?' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_abc',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            }],
          },
          { role: 'tool', tool_call_id: 'call_abc', content: '{"temp":20}' },
        ],
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get the weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          },
        }],
        tool_choice: { type: 'function', function: { name: 'get_weather' } },
      },
      {
        provider: 'google-antigravity',
        model: 'claude-sonnet-4-5',
        baseUrl,
        apiKey: 'oauth-token-123',
        extraConfig: { project: 'test-proj' },
      },
    );
    assert.equal(response.status, 200);

    const request = capturedEnvelope.request;
    assert.deepEqual(request.tools, [{
      functionDeclarations: [{
        name: 'get_weather',
        description: 'Get the weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      }],
    }]);
    assert.deepEqual(request.toolConfig, {
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] },
    });

    const modelTurn = request.contents.find((content) => content.role === 'model');
    assert.deepEqual(modelTurn.parts, [{
      functionCall: { name: 'get_weather', args: { city: 'Paris' }, id: 'call_abc' },
    }]);
    const toolTurn = request.contents.find((content) => content.parts.some((part) => part.functionResponse));
    assert.deepEqual(toolTurn.parts, [{
      functionResponse: { name: 'get_weather', response: { output: '{"temp":20}' }, id: 'call_abc' },
    }]);

    const json = await response.json();
    assert.equal(json.choices[0].message.tool_calls[0].function.name, 'get_weather');
    assert.equal(json.choices[0].finish_reason, 'tool_calls');
  });
});

test('antigravity adapter omits tools and toolConfig when no tools are sent', async () => {
  let capturedEnvelope;
  await withServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    capturedEnvelope = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({
      response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] },
    }) + '\n\n');
  }, async (baseUrl) => {
    const response = await antigravity.chat(
      { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hello' }] },
      {
        provider: 'google-antigravity',
        model: 'claude-sonnet-4-5',
        baseUrl,
        apiKey: 'oauth-token-123',
        extraConfig: { project: 'test-proj' },
      },
    );
    assert.equal(response.status, 200);
    assert.equal(capturedEnvelope.request.tools, undefined);
    assert.equal(capturedEnvelope.request.toolConfig, undefined);
  });
});

test('antigravity adapter signs the first Gemini function call', async () => {
  let capturedEnvelope;
  await withServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    capturedEnvelope = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({
      response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] },
    }) + '\n\n');
  }, async (baseUrl) => {
    const response = await antigravity.chat(
      {
        model: 'gemini-3.6-flash',
        messages: [
          { role: 'user', content: 'Weather in Paris?' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            }],
          },
        ],
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } }],
      },
      {
        provider: 'google-gemini-cli',
        model: 'gemini-3.6-flash',
        baseUrl,
        apiKey: 'oauth-token-123',
      },
    );
    assert.equal(response.status, 200);
    const request = capturedEnvelope.request;
    assert.deepEqual(request.tools, [{
      functionDeclarations: [{ name: 'get_weather', parameters: { type: 'object', properties: {} } }],
    }]);
    assert.equal(request.toolConfig, undefined);
    const modelTurn = request.contents.find((content) => content.role === 'model');
    assert.deepEqual(modelTurn.parts, [{
      functionCall: { name: 'get_weather', args: { city: 'Paris' } },
      thoughtSignature: 'skip_thought_signature_validator',
    }]);
  });
});

test('anthropic adapter clamps thinking max_tokens to modelInfo.maxTokens (M4)', async () => {
  const sent = [];
  const fetchImpl = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      id: 'msg_1',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const baseCtx = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-ant-test',
    modelInfo: { id: 'claude-sonnet-4-5', maxTokens: 64000, reasoning: true },
    fetchImpl,
  };
  // No max_tokens passed -> defaults to modelInfo.maxTokens; adding budget must clamp to 64000.
  await anthropic.chat({ messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'high' }, baseCtx);
  // Explicit max_tokens near cap -> clamped to 64000.
  await anthropic.chat({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 60000, reasoning_effort: 'high' }, baseCtx);
  // Small max_tokens well below cap -> grows by budget as before.
  await anthropic.chat({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 4096, reasoning_effort: 'high' }, baseCtx);

  assert.equal(sent[0].max_tokens, 64000);
  assert.ok(sent[0].thinking.budget_tokens < sent[0].max_tokens);
  assert.equal(sent[1].max_tokens, 64000);
  assert.ok(sent[1].thinking.budget_tokens < sent[1].max_tokens);
  assert.equal(sent[2].max_tokens, 4096 + 3276);
  assert.equal(sent[2].thinking.budget_tokens, 3276);
});

test('openai streaming requests include_usage and retries without stream_options on 400/422 rejection (M6)', async () => {
  const bodies = [];
  let mode = 'accept';
  await withServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const parsed = JSON.parse(raw);
    bodies.push(parsed);
    if (mode === 'reject-stream-options' && parsed.stream_options) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Extra inputs are not permitted: stream_options' } }));
      return;
    }
    if (mode === 'reject-other') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid temperature' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
  }, async (baseUrl) => {
    const ctx = { provider: 'mock', model: 'm', baseUrl, apiKey: 'k', headers: {}, extraConfig: {} };
    // 1. Default streaming sends stream_options.include_usage = true
    const ok = await openai.chat({ messages: [{ role: 'user', content: 'hi' }], stream: true }, ctx);
    assert.equal(ok.status, 200);
    assert.deepEqual(bodies[0].stream_options, { include_usage: true });

    // 2. 400 mentioning stream_options retries once without it and succeeds
    bodies.length = 0;
    mode = 'reject-stream-options';
    const retried = await openai.chat({ messages: [{ role: 'user', content: 'hi' }], stream: true }, ctx);
    assert.equal(retried.status, 200);
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0].stream_options, { include_usage: true });
    assert.equal(bodies[1].stream_options, undefined);

    // 3. 400 not mentioning stream_options does NOT retry
    bodies.length = 0;
    mode = 'reject-other';
    const failed = await openai.chat({ messages: [{ role: 'user', content: 'hi' }], stream: true }, ctx);
    assert.equal(failed.status, 400);
    assert.equal(bodies.length, 1);

    // 4. Caller opting out of include_usage is respected
    bodies.length = 0;
    mode = 'accept';
    await openai.chat(
      { messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: false } },
      ctx,
    );
    assert.deepEqual(bodies[0].stream_options, { include_usage: false });
  });
});

test('translated streaming adapters stamp real model onto every SSE chunk', async () => {
  const sseBody = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
  const response = await anthropic.chat(
    { messages: [{ role: 'user', content: 'hi' }], stream: true },
    {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-test',
      fetchImpl: async () => new Response(sseBody, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    },
  );
  const text = await response.text();
  const frames = text
    .split('\n\n')
    .map((block) => block.replace(/^data:\s*/, '').trim())
    .filter((data) => data && data !== '[DONE]')
    .map((data) => JSON.parse(data));
  assert.ok(frames.length >= 3);
  for (const frame of frames) {
    assert.equal(frame.model, 'claude-sonnet-4-5');
  }
});

test('gateway rejects unauthenticated /v1 requests before JSON parsing (M7) and returns 401 when expired OAuth refresh fails', async () => {
  const { default: miniExpress } = await import('../../server-plugin/lib/mini-express.mjs');
  const { GatewayServer } = await import('../../server-plugin/lib/gateway-server.mjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omtp-gw-'));
  let adapterCalled = 0;
  const server = new GatewayServer({
    root,
    express: miniExpress,
    catalogService: {
      stats: async () => ({ version: '1.0.0' }),
      getProvider: async (id) => ({
        id,
        label: 'TestOAuth',
        gatewayAdapter: 'openai',
        baseUrl: 'https://example.invalid/v1',
        models: [{ id: 'm1', name: 'M1' }],
      }),
    },
    keyStore: {
      resolveProvider: async (provider) => ({
        ...provider,
        adapter: 'openai',
        available: true,
        keySource: 'omtp',
        apiKey: JSON.stringify({ type: 'oauth', access: 'expired-tok', refresh: 'bad-refresh', expires: 1000 }),
      }),
    },
    adapterResolver: async () => ({
      chat: async () => {
        adapterCalled += 1;
        return new Response('{}', { status: 200 });
      },
    }),
  });
  server.token = 'gw-secret';
  server.requireAuth = true;
  const listener = http.createServer(server._buildApp());
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  try {
    // Unauthenticated invalid JSON must fail 401 at auth, not 400 at JSON parser.
    const unauth = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{invalid-json',
    });
    assert.equal(unauth.status, 401);

    // Authenticated request whose expired OAuth refresh fails must return 401 without calling upstream adapter.
    const authed = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer gw-secret' },
      body: JSON.stringify({ model: 'openai-codex/m1', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(authed.status, 401);
    const errBody = await authed.json();
    assert.match(errBody.error.message, /refresh failed/i);
    assert.equal(adapterCalled, 0);
  } finally {
    listener.closeAllConnections?.();
    await new Promise((resolve) => listener.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
