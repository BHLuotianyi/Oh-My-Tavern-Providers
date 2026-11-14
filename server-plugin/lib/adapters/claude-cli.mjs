/**
 * Claude subscription through the official Claude Code CLI (`claude -p`).
 *
 * Anthropic documents `claude -p` as drawing on the user's own plan, and
 * forbids third-party apps from collecting Claude.ai credentials or posing as
 * Claude Code. Here the unmodified CLI signs in and talks to Anthropic; OMTP
 * only hands it the chat. Tools, CLAUDE.md, skills, plugins and hooks are
 * switched off so the CLI acts as a plain model endpoint.
 */
import {
    DEFAULT_SYSTEM_PROMPT,
    catalogChatModels,
    cliEnv,
    cliMissing,
    effortArgs,
    invalidModel,
    isValidModelId,
    prepareWorkDir,
    renderPrompt,
    runCliChat,
    runCliCommand,
    statusForMessage,
    summarizeStderr,
    writeRequestFile,
} from './cli-common.mjs';
import { invalidMessages } from './openai.mjs';

export const id = 'claude-cli';
const LABEL = 'Claude Code';

/**
 * @param {import('./cli-common.mjs').PromptBlock} block
 */
function toClaudeBlock(block) {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if ('data' in block) return { type: 'image', source: { type: 'base64', media_type: block.mediaType, data: block.data } };
    return { type: 'image', source: { type: 'url', url: block.url } };
}

/**
 * Normalize Claude Code's `stream-json` events (with partial messages).
 * Text comes from the raw stream deltas; the final `result` carries usage and
 * errors. A reply that produced no deltas (synthetic errors) is taken from
 * `result.result`.
 * @returns {(event:any) => import('./cli-common.mjs').CliEvent[]}
 */
export function createParser() {
    let streamed = false;
    return (event) => {
        if (event?.type === 'stream_event') {
            const inner = event.event || {};
            if (inner.type !== 'content_block_delta') return [];
            const delta = inner.delta || {};
            if (delta.type === 'text_delta' && delta.text) {
                streamed = true;
                return [{ text: delta.text }];
            }
            if (delta.type === 'thinking_delta' && delta.thinking) return [{ reasoning: delta.thinking }];
            return [];
        }
        if (event?.type !== 'result') return [];
        if (event.is_error || event.subtype !== 'success') {
            const errors = Array.isArray(event.errors) ? event.errors.join('; ') : '';
            const message = (typeof event.result === 'string' && event.result) || errors || `${LABEL} ended with ${event.subtype || 'an error'}`;
            const apiStatus = Number(event.api_error_status) || 0;
            return [{ error: message, status: apiStatus >= 400 ? apiStatus : statusForMessage(message), end: true }];
        }
        const usage = event.usage || {};
        const cacheRead = Number(usage.cache_read_input_tokens) || 0;
        const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
        /** @type {import('./cli-common.mjs').CliEvent[]} */
        const out = [];
        if (!streamed && typeof event.result === 'string' && event.result) out.push({ text: event.result });
        out.push({
            usage: {
                prompt: (Number(usage.input_tokens) || 0) + cacheRead + cacheWrite,
                completion: Number(usage.output_tokens) || 0,
                cached: cacheRead,
                cacheWrite,
            },
            finish: event.stop_reason === 'max_tokens' ? 'length' : 'stop',
            end: true,
        });
        return out;
    };
}

/**
 * Arguments for one non-interactive turn.
 * @param {string} model
 * @param {string} systemFile
 * @param {any} req
 * @returns {string[]}
 */
export function buildArgs(model, systemFile, req) {
    return [
        '-p',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--model', model,
        '--system-prompt-file', systemFile,
        '--tools', '',
        '--safe-mode',
        '--no-session-persistence',
        '--permission-prompts', 'none',
        ...effortArgs(req),
    ];
}

export async function chat(req, ctx) {
    const cli = ctx?.cli;
    if (!cli?.path) return cliMissing(LABEL, ctx);
    if (!isValidModelId(ctx.model)) return invalidModel(ctx.model);
    const prompt = renderPrompt(req?.messages);
    if (!prompt) return invalidMessages();

    const cwd = await prepareWorkDir(cli.workDir);
    const systemFile = await writeRequestFile(cwd, prompt.system || DEFAULT_SYSTEM_PROMPT);
    const input = `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: prompt.blocks.map(toClaudeBlock) },
    })}\n`;
    return runCliChat({
        req,
        ctx,
        label: LABEL,
        executable: cli.path,
        args: buildArgs(ctx.model, systemFile, req),
        env: cliEnv(),
        cwd,
        input,
        parse: createParser(),
        tempFiles: [systemFile],
    });
}

/**
 * Claude Code cannot list models; report the catalog's, after checking the
 * CLI is signed in so the hub can tell a working route from a dead one.
 */
export async function listModels(ctx) {
    const cli = ctx?.cli;
    if (!cli?.path) throw new Error(`${LABEL} (\`claude\`) is not installed`);
    const cwd = await prepareWorkDir(cli.workDir);
    // `auth status` exits non-zero when signed out but still prints its JSON.
    const { stdout, stderr } = await runCliCommand(cli.path, ['auth', 'status', '--json'], {
        cwd,
        env: cliEnv(),
        signal: ctx?.signal,
        label: LABEL,
    });
    let status;
    try {
        status = JSON.parse(stdout);
    } catch {
        throw new Error(summarizeStderr(stderr) || `${LABEL} returned an unreadable auth status`);
    }
    if (!status?.loggedIn) {
        throw new Error(`${LABEL} is not signed in (HTTP 401): run \`claude\` in a terminal and sign in`);
    }
    return catalogChatModels(ctx);
}

export default { id, chat, listModels };
