import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { parseSse, parseSseBlock, openAIChunk, done } from '../../server-plugin/lib/sse.mjs';

test('parseSse yields event/data pairs across chunks', async () => {
  const stream = Readable.from([
    'event: message\ndata: {"a":1}\n\n',
    'data: hello\n',
    'data: world\n\n',
    'data: [DONE]\n\n',
  ]);
  const events = [];
  for await (const event of parseSse(stream)) events.push(event);
  assert.deepEqual(events.map((event) => event.data), ['{"a":1}', 'hello\nworld', '[DONE]']);
  assert.equal(events[0].event, 'message');
});

test('parseSseBlock handles comments and CRLF', () => {
  const parsed = parseSseBlock('event: x\r\ndata: a\r\ndata: b\r\n: comment\r\n\r\n');
  assert.equal(parsed.event, 'x');
  assert.equal(parsed.data, 'a\nb');
});

test('openAIChunk and done produce OpenAI SSE frames', () => {
  const chunk = openAIChunk({ content: 'pong' }, 'stop', { model: 'mock/echo' });
  assert.match(chunk, /^data: /);
  const parsed = JSON.parse(chunk.slice(6));
  assert.equal(parsed.choices[0].delta.content, 'pong');
  assert.equal(parsed.choices[0].finish_reason, 'stop');
  assert.equal(parsed.model, 'mock/echo');
  assert.equal(done(), 'data: [DONE]\n\n');
});
