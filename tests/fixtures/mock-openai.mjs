#!/usr/bin/env node
import http from 'node:http';

const port = Number(process.env.PORT || 4199);

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    return json(res, 200, {
      object: 'list',
      data: [{ id: 'echo', object: 'model', owned_by: 'mock', created: 0 }],
    });
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: { message: 'invalid json', type: 'invalid_request_error' } }); }
    const content = parsed.messages?.map((m) => m.content).filter((v) => typeof v === 'string').join(' ') || '';
    const reply = content.toLowerCase().includes('ping') ? 'pong' : `echo: ${content}`;
    const model = parsed.model || 'echo';
    if (parsed.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const chunks = [
        { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
        { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] },
        { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ];
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    return json(res, 200, {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      created: 0,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }
  json(res, 404, { error: { message: `not found: ${req.method} ${url.pathname}`, type: 'invalid_request_error' } });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[omtp-mock] listening on http://127.0.0.1:${port}/v1`);
});
