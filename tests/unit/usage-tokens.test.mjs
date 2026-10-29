import test from 'node:test';
import assert from 'node:assert/strict';
import { openAIUsage } from '../../server-plugin/lib/adapters/openai.mjs';
import { translateGoogleCompletion } from '../../server-plugin/lib/adapters/google.mjs';
import { tokensFromOpenAIUsage } from '../../server-plugin/lib/stats.mjs';

test('openAIUsage keeps the cache and reasoning breakdown', () => {
    const usage = openAIUsage({ prompt: 1200, completion: 80, cached: 900, cacheWrite: 50, reasoning: 30 });
    assert.equal(usage.prompt_tokens, 1200);
    assert.equal(usage.prompt_tokens_details.cached_tokens, 900);
    assert.equal(usage.prompt_tokens_details.cache_write_tokens, 50);
    assert.equal(usage.completion_tokens_details.reasoning_tokens, 30);
    assert.deepEqual(tokensFromOpenAIUsage(usage), {
        input: 250, cachedInput: 900, cacheWrite: 50, output: 80, reasoning: 30,
    });
    // No details when the provider reported no cache/thinking numbers.
    assert.equal(openAIUsage({ prompt: 5, completion: 1 }).prompt_tokens_details, undefined);
});

test('gemini cache hits and thoughts survive the adapter', () => {
    const completion = translateGoogleCompletion({
        responseId: 'r1',
        candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
        usageMetadata: {
            promptTokenCount: 5000,
            candidatesTokenCount: 40,
            totalTokenCount: 5120,
            cachedContentTokenCount: 4096,
            thoughtsTokenCount: 80,
        },
    }, 'gemini-3.8-flash');
    assert.equal(completion.usage.prompt_tokens, 5000);
    assert.equal(completion.usage.prompt_tokens_details.cached_tokens, 4096);
    assert.equal(completion.usage.completion_tokens_details.reasoning_tokens, 80);
    assert.deepEqual(tokensFromOpenAIUsage(completion.usage), {
        input: 904, cachedInput: 4096, cacheWrite: 0, output: 40, reasoning: 80,
    });
});

test('gemini streaming usage frame carries cache hits', async () => {
    const { createGoogleStreamHandler } = await import('../../server-plugin/lib/adapters/google.mjs');
    const frames = [];
    const emit = (frame) => frames.push(String(frame));
    const handler = createGoogleStreamHandler('gemini-3.8-flash');
    handler.onStart(emit);
    handler.onEvent({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 10, totalTokenCount: 2050, cachedContentTokenCount: 1536 },
    }, emit);
    handler.onEnd(emit);
    const usageFrame = frames.filter((f) => f.includes('"usage"')).pop();
    const usage = JSON.parse(usageFrame.replace(/^data:\s*/, '')).usage;
    assert.equal(usage.prompt_tokens, 2000);
    assert.equal(usage.prompt_tokens_details.cached_tokens, 1536);
    assert.deepEqual(tokensFromOpenAIUsage(usage), {
        input: 464, cachedInput: 1536, cacheWrite: 0, output: 10, reasoning: 0,
    });
});

test('responses streaming usage frame carries cache and reasoning tokens', async () => {
    const { createResponsesStreamHandler } = await import('../../server-plugin/lib/adapters/responses.mjs');
    const frames = [];
    const emit = (frame) => frames.push(String(frame));
    const handler = createResponsesStreamHandler('gpt-5');
    handler.onStart(emit);
    handler.onEvent({
        type: 'response.completed',
        response: {
            status: 'completed',
            usage: {
                input_tokens: 2000,
                output_tokens: 100,
                total_tokens: 2100,
                input_tokens_details: { cached_tokens: 1536 },
                output_tokens_details: { reasoning_tokens: 64 },
            },
        },
    }, emit);
    handler.onEnd(emit);
    const usageFrame = frames.filter((f) => f.includes('"usage"')).pop();
    const usage = JSON.parse(usageFrame.replace(/^data:\s*/, '')).usage;
    assert.equal(usage.prompt_tokens, 2000);
    assert.equal(usage.prompt_tokens_details.cached_tokens, 1536);
    assert.equal(usage.completion_tokens_details.reasoning_tokens, 64);
    assert.deepEqual(tokensFromOpenAIUsage(usage), {
        input: 464, cachedInput: 1536, cacheWrite: 0, output: 100, reasoning: 64,
    });
});
