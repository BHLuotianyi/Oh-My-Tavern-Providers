/**
 * Gemini Code Assist through the official Gemini CLI (`gemini`) headless mode.
 *
 * Google forbids third-party tools from reusing Gemini CLI OAuth; the CLI keeps
 * its own sign-in and transport. `GEMINI_SYSTEM_MD` replaces the CLI's coding
 * prompt with the chat's system prompt, and a workspace settings file in the
 * private working folder disables every built-in tool. Extensions and MCP
 * servers are switched off on the command line.
 */
import path from 'node:path';
import {
    DEFAULT_SYSTEM_PROMPT,
    catalogChatModels,
    cliEnv,
    cliMissing,
    invalidModel,
    isValidModelId,
    prepareWorkDir,
    promptText,
    renderPrompt,
    runCliChat,
    statusForMessage,
    textOnly,
    writeIfChanged,
    writeRequestFile,
} from './cli-common.mjs';
import { invalidMessages } from './openai.mjs';

export const id = 'gemini-cli';
const LABEL = 'Gemini CLI';

/** Workspace settings: an empty core-tool allowlist registers no built-in tools. */
export const WORKSPACE_SETTINGS = `${JSON.stringify({ tools: { core: [] } }, null, 2)}\n`;

/** An MCP allowlist naming no configured server. */
const NO_MCP_SERVER = 'omtp-no-mcp';

/**
 * Normalize Gemini CLI's `stream-json` events: assistant `message` deltas
 * carry the text; `result` carries status and token stats.
 * @returns {(event:any) => import('./cli-common.mjs').CliEvent[]}
 */
export function createParser() {
    return (event) => {
        if (event?.type === 'message') {
            if (event.role === 'assistant' && typeof event.content === 'string' && event.content) {
                return [{ text: event.content }];
            }
            return [];
        }
        if (event?.type !== 'result') return [];
        if (event.status !== 'success') {
            const message = event.error?.message || `${LABEL} ended with status ${event.status || 'unknown'}`;
            return [{ error: message, status: statusForMessage(message), end: true }];
        }
        const stats = event.stats || {};
        return [{
            usage: {
                prompt: Number(stats.input_tokens) || 0,
                completion: Number(stats.output_tokens) || 0,
                cached: Number(stats.cached) || 0,
            },
            finish: 'stop',
            end: true,
        }];
    };
}

/**
 * @param {string} model
 * @returns {string[]}
 */
export function buildArgs(model) {
    return [
        '--output-format', 'stream-json',
        '--skip-trust',
        '--extensions', 'none',
        '--allowed-mcp-server-names', NO_MCP_SERVER,
        '--model', model,
    ];
}

export async function chat(req, ctx) {
    const cli = ctx?.cli;
    if (!cli?.path) return cliMissing(LABEL, ctx);
    if (!isValidModelId(ctx.model)) return invalidModel(ctx.model);
    const prompt = renderPrompt(req?.messages);
    if (!prompt) return invalidMessages();
    const text = promptText(prompt);
    if (text == null) return textOnly(LABEL);

    const cwd = await prepareWorkDir(cli.workDir);
    await writeIfChanged(path.join(cwd, '.gemini', 'settings.json'), WORKSPACE_SETTINGS);
    const systemFile = await writeRequestFile(cwd, prompt.system || DEFAULT_SYSTEM_PROMPT);
    // Without a TTY the CLI reads its prompt from stdin and runs headless.
    return runCliChat({
        req,
        ctx,
        label: LABEL,
        executable: cli.path,
        args: buildArgs(ctx.model),
        env: cliEnv({ GEMINI_SYSTEM_MD: systemFile }),
        cwd,
        input: text,
        parse: createParser(),
        tempFiles: [systemFile],
    });
}

/** Gemini CLI has no model listing; the catalog's models are what it serves. */
export async function listModels(ctx) {
    if (!ctx?.cli?.path) throw new Error(`${LABEL} (\`gemini\`) is not installed`);
    return catalogChatModels(ctx);
}

export default { id, chat, listModels };
