import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import openai from '../../server-plugin/lib/adapters/openai.mjs';
import anthropic from '../../server-plugin/lib/adapters/anthropic.mjs';
import antigravity from '../../server-plugin/lib/adapters/antigravity.mjs';

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
  await withServer(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"pong"}}]}\n\n');
    res.end('data: [DONE]\n\n');
  }, async (baseUrl) => {
    const response = await openai.chat(
      { model: 'echo', messages: [{ role: 'user', content: 'ping' }], stream: true },
      { provider: 'mock', model: 'echo', baseUrl, apiKey: 'test', headers: {}, extraConfig: {} },
    );
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /pong/);
    assert.match(text, /\[DONE\]/);
  });
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
  await withServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    capturedHeaders = req.headers;
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
      { model: 'claude-3-7-sonnet', messages: [{ role: 'user', content: 'hello' }] },
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
    assert.match(capturedBody.system, /You are Claude Code/);
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
