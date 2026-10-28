/**
 * Shared Server-Sent Events helpers for the OMTP gateway and its adapters.
 */

/**
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string>}
 */
export function sseHeaders(extra = {}) {
    return {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...extra,
    };
}

/**
 * @param {unknown} value
 * @returns {any}
 */
function toAsyncIterable(value) {
    if (!value) return null;
    if (typeof value[Symbol.asyncIterator] === 'function') return value;
    if (typeof value.getReader === 'function') {
        const reader = value.getReader();
        const decoder = new TextDecoder();
        return {
            async *[Symbol.asyncIterator]() {
                try {
                    while (true) {
                        const { done, value: chunk } = await reader.read();
                        if (done) break;
                        if (typeof chunk === 'string') yield chunk;
                        else yield decoder.decode(chunk, { stream: true });
                    }
                } finally {
                    try {
                        reader.releaseLock();
                    } catch {
                        // Reader already released.
                    }
                }
            },
        };
    }
    if (typeof value[Symbol.iterator] === 'function') {
        return {
            async *[Symbol.asyncIterator]() {
                for (const chunk of value) yield chunk;
            },
        };
    }
    return null;
}

/**
 * Parse an SSE byte/text stream into events.
 * Accepts a web ReadableStream, a Node readable, a Response body, or an async iterable of strings.
 * @param {any} stream
 * @returns {AsyncGenerator<{event:string, data:string, id:string}>}
 */
export async function* parseSse(stream) {
    const iterable = toAsyncIterable(stream);
    if (!iterable) return;
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of iterable) {
        buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const parsed = parseSseBlock(block);
            if (parsed) yield parsed;
            boundary = buffer.indexOf('\n\n');
        }
    }
    buffer = buffer.replace(/\r\n/g, '\n').trim();
    if (buffer) {
        const parsed = parseSseBlock(buffer);
        if (parsed) yield parsed;
    }
}

/**
 * @param {string} block
 * @returns {{event:string, data:string, id:string}|null}
 */
export function parseSseBlock(block) {
    const data = [];
    let event = '';
    let id = '';
    for (const line of String(block).replace(/\r\n/g, '\n').split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const separator = line.indexOf(':');
        const field = separator === -1 ? line : line.slice(0, separator);
        let value = separator === -1 ? '' : line.slice(separator + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') data.push(value);
        else if (field === 'event') event = value;
        else if (field === 'id') id = value;
    }
    if (data.length === 0) return null;
    return { event, data: data.join('\n'), id };
}

/**
 * Build an OpenAI chat.completion.chunk SSE frame.
 * @param {Record<string, unknown>} delta
 * @param {string|null} [finishReason]
 * @param {{model?:string, id?:string, created?:number, usage?:Record<string, unknown>|null}} [extra]
 * @returns {string}
 */
export function openAIChunk(delta, finishReason = null, extra = {}) {
    /** @type {Record<string, unknown>} */
    const payload = {
        id: extra.id || `chatcmpl-omtp-${Date.now().toString(36)}`,
        object: 'chat.completion.chunk',
        created: extra.created || Math.floor(Date.now() / 1000),
        model: extra.model || '',
        choices: [
            {
                index: 0,
                delta,
                finish_reason: finishReason ?? null,
            },
        ],
    };
    if (extra.usage) payload.usage = extra.usage;
    return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * @returns {string}
 */
export function done() {
    return 'data: [DONE]\n\n';
}

/**
 * @param {string} message
 * @param {string} [type]
 * @param {string|null} [code]
 * @returns {{error:{message:string,type:string,code:string|null}}}
 */
export function openAIErrorEnvelope(message, type = 'invalid_request_error', code = null) {
    return { error: { message, type, code } };
}

/**
 * @param {number} status
 * @param {string} message
 * @param {string} [type]
 * @param {string|null} [code]
 * @returns {Response}
 */
export function openAIErrorResponse(status, message, type = 'invalid_request_error', code = null) {
    return new Response(JSON.stringify(openAIErrorEnvelope(message, type, code)), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
}

/**
 * Wrap an async iterable of SSE frames in a web ReadableStream.
 * @param {AsyncIterable<string>|Iterable<string>} frames
 * @returns {ReadableStream<Uint8Array>}
 */
export function createSseStream(frames) {
    const encoder = new TextEncoder();
    const iterator = frames[Symbol.asyncIterator] ? frames[Symbol.asyncIterator]() : frames[Symbol.iterator]();
    return new ReadableStream({
        async pull(controller) {
            try {
                const { value, done: finished } = await iterator.next();
                if (finished) {
                    controller.close();
                    return;
                }
                controller.enqueue(encoder.encode(value));
            } catch (error) {
                controller.error(error);
            }
        },
        async cancel() {
            if (typeof iterator.return === 'function') {
                await iterator.return().catch(() => {});
            }
        },
    });
}

/**
 * Build a streaming SSE Response from an async iterable of frames.
 * @param {AsyncIterable<string>|Iterable<string>} frames
 * @param {Record<string, string>} [headers]
 * @returns {Response}
 */
export function sseResponse(frames, headers = {}) {
    return new Response(createSseStream(frames), { status: 200, headers: sseHeaders(headers) });
}

/**
 * Build a complete non-streaming OpenAI chat completion response.
 * @param {string} content
 * @param {{model?:string, toolCalls?:Array<Record<string, unknown>>, finishReason?:string, usage?:Record<string, unknown>|null, reasoning?:string}} [options]
 * @returns {Response}
 */
export function openAIJsonResponse(content, options = {}) {
    const message = { role: 'assistant', content: content ?? '' };
    if (options.reasoning) message.reasoning_content = options.reasoning;
    if (Array.isArray(options.toolCalls) && options.toolCalls.length > 0) {
        message.tool_calls = options.toolCalls;
        message.content = content || null;
    }
    const payload = {
        id: `chatcmpl-omtp-${Date.now().toString(36)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: options.model || '',
        choices: [
            {
                index: 0,
                message,
                finish_reason: options.finishReason || (message.tool_calls ? 'tool_calls' : 'stop'),
            },
        ],
        ...(options.usage ? { usage: options.usage } : {}),
    };
    return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
}
