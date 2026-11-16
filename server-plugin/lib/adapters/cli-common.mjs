/**
 * Shared runtime for adapters that drive a vendor's official CLI instead of
 * calling its API with a borrowed subscription token (`cli-routes.mjs`).
 *
 * Each request spawns the CLI once: the OpenAI messages are rendered into a
 * single prompt (the CLIs keep their own sessions, SillyTavern resends the
 * whole chat every time), the CLI's NDJSON events are normalized by a
 * per-adapter parser, and the result is returned as an OpenAI chat completion,
 * streamed or not. Sampling parameters (temperature, top_p, stop, max tokens)
 * have no CLI equivalent and are not forwarded.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import {
    JSON_HEADERS,
    errorFrame,
    errorResponse,
    newCompletionId,
    normalizeTurns,
    openAIUsage,
    parseDataUrl,
    usageFrame,
} from './openai.mjs';
import { childProxyEnv } from '../proxy-fetch.mjs';
import { done, openAIChunk, sseHeaders } from '../sse.mjs';

/** Fallback when the chat has no system prompt; the CLIs' own prompts are coding agents. */
export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';

const TRANSCRIPT_INSTRUCTION = 'The conversation so far is below, one <user> or <assistant> element per turn. '
    + 'Write only the next assistant turn: no role label, no XML tags, nothing before or after it.';
const CONTINUE_INSTRUCTION = 'The last <assistant> turn is unfinished: continue it from exactly where it stops, without repeating any of it.';

/** Reasoning efforts the three CLIs accept on `--effort`. */
const CLI_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** How long a terminated CLI gets before it is killed outright. */
const KILL_GRACE_MS = 3_000;
/** Bytes of stderr kept for error messages. */
const STDERR_LIMIT = 16_384;

/**
 * @typedef {{type:'text', text:string}|{type:'image', mediaType:string, data:string}|{type:'image', url:string}} PromptBlock
 * @typedef {{system:string, blocks:PromptBlock[]}} Prompt
 * @typedef {{text?:string, reasoning?:string, usage?:{prompt?:number, completion?:number, cached?:number, cacheWrite?:number, reasoning?:number}, finish?:string, error?:string, status?:number, end?:boolean}} CliEvent
 */

/**
 * @param {string} url
 * @returns {PromptBlock|null}
 */
function imageBlock(url) {
    if (!url) return null;
    const inline = parseDataUrl(url);
    if (inline) return { type: 'image', mediaType: inline.mimeType, data: inline.data };
    return { type: 'image', url };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function argumentsText(value) {
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value ?? {});
    } catch {
        return '';
    }
}

/**
 * Render OpenAI messages into one prompt: all system/developer text becomes
 * the system prompt (as the HTTP adapters do), and the turns become a tagged
 * transcript with an instruction to write the next assistant turn.
 * @param {any[]} messages
 * @returns {Prompt|null} null when there is no user/assistant content
 */
export function renderPrompt(messages) {
    const { system, turns } = normalizeTurns(messages, {
        mapText: (text) => ({ type: 'text', text }),
        mapImage: (_part, url) => imageBlock(url),
        mapToolCall: (call) => ({ type: 'text', text: `[called tool ${call.name}: ${argumentsText(call.rawArguments)}]` }),
        mapToolResult: (result) => ({ type: 'text', text: `[tool ${result.name || result.toolCallId || 'result'} returned: ${result.content}]` }),
    });
    if (turns.length === 0) return null;

    /** @type {PromptBlock[]} */
    const blocks = [];
    const pushText = (text) => {
        const last = blocks[blocks.length - 1];
        if (last?.type === 'text') last.text += text;
        else blocks.push({ type: 'text', text });
    };
    const continuing = turns[turns.length - 1].role === 'assistant';
    pushText(continuing ? `${TRANSCRIPT_INSTRUCTION} ${CONTINUE_INSTRUCTION}\n` : `${TRANSCRIPT_INSTRUCTION}\n`);
    for (const turn of turns) {
        pushText(`\n<${turn.role}>\n`);
        for (const part of turn.content) {
            if (part.type === 'text') pushText(part.text);
            else blocks.push(part);
        }
        pushText(`\n</${turn.role}>\n`);
    }
    return { system: system.join('\n\n'), blocks };
}

/**
 * The prompt as plain text, or null when it carries images.
 * @param {Prompt} prompt
 * @returns {string|null}
 */
export function promptText(prompt) {
    if (prompt.blocks.some((block) => block.type !== 'text')) return null;
    return prompt.blocks.map((block) => /** @type {{text:string}} */ (block).text).join('');
}

/**
 * Model ids reach the CLI's argv; keep them to the characters model slugs use.
 * @param {unknown} model
 * @returns {boolean}
 */
export function isValidModelId(model) {
    return typeof model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,127}$/.test(model);
}

/**
 * `--effort <level>` for a request's `reasoning_effort`, when the CLIs know it.
 * @param {any} req
 * @returns {string[]}
 */
export function effortArgs(req) {
    const effort = String(req?.reasoning_effort || '').toLowerCase();
    return CLI_EFFORTS.has(effort) ? ['--effort', effort] : [];
}

/**
 * HTTP status for a CLI error message.
 * @param {string} message
 * @returns {number}
 */
export function statusForMessage(message) {
    const text = String(message || '');
    if (/permission_denied|disabled in this account|violation of terms|\b403\b/i.test(text)) return 403;
    if (/not logged in|please run \/login|authentication required|not authenticated|sign in|\b401\b/i.test(text)) return 401;
    if (/rate.?limit|resource_exhausted|quota|usage limit|\b429\b/i.test(text)) return 429;
    if (/not recognized|unknown model|invalid model|model .* not (?:found|available)/i.test(text)) return 400;
    return 502;
}

/**
 * The informative part of a CLI's stderr: drop terminal warnings and stack
 * frames, keep the first error line.
 * @param {string} stderr
 * @returns {string}
 */
export function summarizeStderr(stderr) {
    const lines = String(stderr || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !/^warning:/i.test(line) && !/^at\s/.test(line));
    const error = lines.find((line) => /error/i.test(line)) || lines[0] || '';
    return error.slice(0, 500);
}

/** @param {string} label @param {any} ctx */
export function cliMissing(label, ctx) {
    const command = ctx?.cli?.command || label;
    return errorResponse(`${label} (\`${command}\`) is not installed on the machine running SillyTavern`, {
        status: 503,
        type: 'invalid_request_error',
        code: 'cli_not_found',
    });
}

/** @param {string} model */
export function invalidModel(model) {
    return errorResponse(`Invalid model id for a CLI provider: ${model}`, {
        status: 400,
        type: 'invalid_request_error',
        code: 'invalid_model',
    });
}

/** @param {string} label */
export function textOnly(label) {
    return errorResponse(`${label} only accepts text; remove the images from this chat request`, {
        status: 400,
        type: 'invalid_request_error',
        code: 'unsupported_content',
    });
}

/**
 * Create the CLI's private working folder (it sees no project files there).
 * @param {string} dir
 * @returns {Promise<string>}
 */
export async function prepareWorkDir(dir) {
    await fs.mkdir(dir, { recursive: true });
    return dir;
}

/**
 * Write `content` to `file` unless it already holds exactly that.
 * @param {string} file
 * @param {string} content
 */
export async function writeIfChanged(file, content) {
    const current = await fs.readFile(file, 'utf8').catch(() => null);
    if (current === content) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, { mode: 0o600 });
}

/**
 * Write a per-request file (system prompt) the CLI reads by path.
 * @param {string} workDir
 * @param {string} content
 * @returns {Promise<string>}
 */
export async function writeRequestFile(workDir, content) {
    const dir = path.join(workDir, '.omtp-requests');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${crypto.randomUUID()}.md`);
    await fs.writeFile(file, content, { mode: 0o600 });
    return file;
}

/**
 * cmd.exe argument quoting for npm `.cmd` shims, which Node only spawns
 * through a shell. Arguments are model ids and OMTP-generated paths.
 * @param {string} value
 * @returns {string}
 */
function quoteWindowsArg(value) {
    if (/["\r\n]/.test(value)) throw new Error('Unsupported character in CLI argument');
    return `"${value}"`;
}

/**
 * @param {string} executable
 * @param {string[]} args
 * @param {{cwd:string, env:Record<string, string|undefined>}} options
 */
function spawnCli(executable, args, { cwd, env }) {
    const viaShell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable);
    return spawn(
        viaShell ? quoteWindowsArg(executable) : executable,
        viaShell ? args.map(quoteWindowsArg) : args,
        { cwd, env, shell: viaShell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
}

/**
 * @param {import('node:child_process').ChildProcess} child
 */
function terminate(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, KILL_GRACE_MS).unref();
}

/**
 * Run a CLI to completion, yielding normalized events. Always ends with an
 * `end` event; a CLI that exits without one yields an error built from its
 * stderr.
 * @param {{executable:string, args:string[], env:Record<string, string|undefined>, cwd:string, input:string, parse:(event:any) => CliEvent[], label:string, signal?:AbortSignal|null}} options
 * @returns {{events: AsyncGenerator<CliEvent>, stop: () => void}}
 */
function runProcess({ executable, args, env, cwd, input, parse, label, signal }) {
    const child = spawnCli(executable, args, { cwd, env });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
        if (stderr.length < STDERR_LIMIT) stderr += chunk;
    });
    /** @type {Error|null} */
    let spawnError = null;
    const exited = new Promise((resolve) => {
        child.once('error', (error) => {
            spawnError = error;
            resolve(null);
        });
        child.once('close', (code, sig) => resolve({ code, signal: sig }));
    });
    // A CLI that exits before reading its prompt closes stdin under us.
    child.stdin.on('error', () => {});
    child.stdin.end(input);

    const stop = () => terminate(child);
    const onAbort = () => stop();
    signal?.addEventListener('abort', onAbort, { once: true });

    async function* events() {
        let ended = false;
        try {
            const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
            for await (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('{')) continue;
                let event;
                try {
                    event = JSON.parse(trimmed);
                } catch {
                    continue;
                }
                for (const normalized of parse(event)) {
                    yield normalized;
                    if (normalized.end) ended = true;
                }
                if (ended) break;
            }
            if (ended) return;
            const exit = await exited;
            if (signal?.aborted) return;
            const reason = spawnError
                ? `${label} could not start: ${spawnError.message}`
                : summarizeStderr(stderr) || `${label} exited with code ${exit?.code ?? exit?.signal ?? 'unknown'} without a reply`;
            yield { error: reason, status: spawnError ? 503 : statusForMessage(reason), end: true };
        } finally {
            signal?.removeEventListener('abort', onAbort);
            stop();
        }
    }
    return { events: events(), stop };
}

/**
 * @param {CliEvent['usage']} usage
 */
function toOpenAIUsage(usage) {
    return usage ? openAIUsage(usage) : null;
}

/**
 * Run a CLI request and translate it into an OpenAI chat completion.
 *
 * Errors that arrive before any text become a plain HTTP error so SillyTavern
 * shows the CLI's message (for example "not logged in"); later errors end the
 * stream with an error frame.
 *
 * @param {object} options
 * @param {any} options.req OpenAI chat request
 * @param {any} options.ctx adapter ctx (`model`, `signal`)
 * @param {string} options.label
 * @param {string} options.executable
 * @param {string[]} options.args
 * @param {Record<string, string|undefined>} options.env
 * @param {string} options.cwd
 * @param {string} options.input written to the CLI's stdin
 * @param {(event:any) => CliEvent[]} options.parse
 * @param {string[]} [options.tempFiles] removed once the CLI exits
 * @returns {Promise<Response>}
 */
export async function runCliChat({ req, ctx, label, executable, args, env, cwd, input, parse, tempFiles = [] }) {
    const cleanup = () => Promise.all(tempFiles.map((file) => fs.rm(file, { force: true }).catch(() => {})));
    let run;
    try {
        run = runProcess({ executable, args, env, cwd, input, parse, label, signal: ctx?.signal });
    } catch (error) {
        await cleanup();
        return errorResponse(`${label} could not start: ${error instanceof Error ? error.message : error}`, {
            status: 503,
            type: 'upstream_error',
            code: 'cli_spawn_failed',
        });
    }
    const { events, stop } = run;
    const model = ctx?.model || '';

    /** @type {CliEvent[]} */
    const buffered = [];
    /** @type {CliEvent|null} */
    let failure = null;
    try {
        // Pull by hand: breaking a `for await` would close the generator and
        // kill the CLI before the rest of the reply is read.
        while (true) {
            const next = await events.next();
            if (next.done) break;
            const event = next.value;
            if (event.error) {
                failure = event;
                break;
            }
            buffered.push(event);
            if (event.text || event.reasoning || event.end) break;
        }
    } catch (error) {
        failure = { error: error instanceof Error ? error.message : String(error), status: 502 };
    }
    if (failure || (!buffered.length && ctx?.signal?.aborted)) {
        stop();
        await events.return(undefined).catch(() => {});
        await cleanup();
        const message = failure?.error || `${label} request aborted`;
        const status = failure?.status || (ctx?.signal?.aborted ? 499 : 502);
        return errorResponse(message, {
            status,
            type: status === 401 || status === 403 ? 'authentication_error' : 'upstream_error',
            code: status === 499 ? 'aborted' : 'cli_error',
        });
    }

    if (!req?.stream) {
        let text = '';
        let reasoning = '';
        let usage = null;
        let finish = 'stop';
        try {
            const consume = (event) => {
                if (event.error) throw Object.assign(new Error(event.error), { status: event.status || 502 });
                if (event.text) text += event.text;
                if (event.reasoning) reasoning += event.reasoning;
                if (event.usage) usage = toOpenAIUsage(event.usage);
                if (event.finish) finish = event.finish;
            };
            for (const event of buffered) consume(event);
            for await (const event of events) consume(event);
        } catch (error) {
            const status = Number(/** @type {any} */ (error)?.status) || 502;
            return errorResponse(error instanceof Error ? error.message : String(error), {
                status,
                type: status === 401 || status === 403 ? 'authentication_error' : 'upstream_error',
                code: 'cli_error',
            });
        } finally {
            await cleanup();
        }
        /** @type {Record<string, any>} */
        const message = { role: 'assistant', content: text };
        if (reasoning) message.reasoning_content = reasoning;
        const body = {
            id: newCompletionId(),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, message, finish_reason: finish }],
            ...(usage ? { usage } : {}),
        };
        return new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS });
    }

    const encoder = new TextEncoder();
    const id = newCompletionId();
    const created = Math.floor(Date.now() / 1000);
    const frame = (delta, finishReason = null) => openAIChunk(delta, finishReason, { id, created, model });
    const body = new ReadableStream({
        async start(controller) {
            const emit = (text) => controller.enqueue(encoder.encode(text));
            let usage = null;
            let finish = 'stop';
            const forward = (event) => {
                if (event.error) throw new Error(event.error);
                if (event.text) emit(frame({ content: event.text }));
                if (event.reasoning) emit(frame({ reasoning_content: event.reasoning }));
                if (event.usage) usage = toOpenAIUsage(event.usage);
                if (event.finish) finish = event.finish;
            };
            try {
                emit(frame({ role: 'assistant', content: '' }));
                for (const event of buffered) forward(event);
                for await (const event of events) forward(event);
                emit(frame({}, finish));
                if (usage) emit(usageFrame(usage, model));
                emit(done());
            } catch (error) {
                if (!ctx?.signal?.aborted) emit(errorFrame(error));
            } finally {
                await cleanup();
                try {
                    controller.close();
                } catch {
                    /* stream already closed */
                }
            }
        },
        cancel() {
            stop();
        },
    });
    return new Response(body, { status: 200, headers: sseHeaders() });
}

/**
 * Run a short CLI command (status / model listing). Resolves with its exit
 * code and output; only a failure to start rejects.
 * @param {string} executable
 * @param {string[]} args
 * @param {{cwd:string, env?:Record<string, string|undefined>, signal?:AbortSignal|null, timeoutMs?:number, label:string}} options
 * @returns {Promise<{code:number|null, stdout:string, stderr:string}>}
 */
export function runCliCommand(executable, args, { cwd, env = process.env, signal = null, timeoutMs = 20_000, label }) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawnCli(executable, args, { cwd, env });
        } catch (error) {
            reject(error);
            return;
        }
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            if (stderr.length < STDERR_LIMIT) stderr += chunk;
        });
        child.stdin.on('error', () => {});
        child.stdin.end();
        const timer = setTimeout(() => terminate(child), timeoutMs);
        const onAbort = () => terminate(child);
        signal?.addEventListener('abort', onAbort, { once: true });
        child.once('error', (error) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            reject(new Error(`${label} could not start: ${error.message}`));
        });
        child.once('close', (code) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve({ code, stdout, stderr });
        });
    });
}

/**
 * The catalog's chat models, for CLIs that cannot list models themselves.
 * @param {any} ctx
 * @returns {{id:string, name:string}[]}
 */
export function catalogChatModels(ctx) {
    const models = Array.isArray(ctx?.catalogProvider?.models) ? ctx.catalogProvider.models : [];
    return models
        .filter((model) => model && typeof model.id === 'string' && (!model.kind || model.kind === 'chat'))
        .map((model) => ({ id: model.id, name: model.name || model.id }));
}

/**
 * The environment a CLI runs with: SillyTavern's own plus the proxy OMTP's
 * requests use (from the settings or the system proxy, which the CLI cannot
 * see), without Node debugger or loader flags that would leak into a
 * Node-based CLI.
 * @param {Record<string, string|undefined>} [extra]
 * @returns {Record<string, string|undefined>}
 */
export function cliEnv(extra = {}) {
    const env = { ...process.env, ...childProxyEnv(), ...extra };
    delete env.NODE_OPTIONS;
    delete env.NODE_INSPECT_RESUME_ON_START;
    return env;
}
