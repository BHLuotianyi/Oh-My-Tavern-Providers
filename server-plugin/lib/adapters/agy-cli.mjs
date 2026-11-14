/**
 * Google Antigravity through the official Antigravity CLI (`agy`) headless mode.
 *
 * Google forbids third-party tools from reusing Antigravity OAuth; `agy` keeps
 * its own sign-in and transport. A dedicated agent definition removes agy's
 * built-in coding prompt and tools; the chat's system prompt travels in the
 * user message because headless mode has no system-prompt flag.
 */
import os from 'node:os';
import path from 'node:path';
import {
    cliEnv,
    cliMissing,
    effortArgs,
    invalidModel,
    isValidModelId,
    prepareWorkDir,
    promptText,
    renderPrompt,
    runCliChat,
    runCliCommand,
    statusForMessage,
    summarizeStderr,
    textOnly,
    writeIfChanged,
} from './cli-common.mjs';
import { invalidMessages } from './openai.mjs';

export const id = 'agy-cli';
const LABEL = 'Antigravity CLI';
export const AGENT_NAME = 'omtp-chat';

/** Custom agent: no default prompt sections, no tools, nothing inherited. */
export const AGENT_DEFINITION = `---
name: ${AGENT_NAME}
description: Chat backend for OMTP Model Hub (SillyTavern). No tools; instructions arrive with each message.
mainAgent: true
subagent: false
tools: []
inheritCustomizations: false
excludeDefaultComponents: true
---
You write replies for a chat front end. Each user message carries the system instructions and the conversation so far. Follow those instructions and write only the reply they ask for.
`;

/**
 * agy reads custom agents from its config folder (`~/.gemini/config/agents`).
 * @returns {string}
 */
function agentFile() {
    return path.join(os.homedir(), '.gemini', 'config', 'agents', `${AGENT_NAME}.md`);
}

/**
 * Normalize agy's `stream-json` events: `agent_response` step deltas carry
 * the text; the per-turn `result` carries status and usage.
 * @returns {(event:any) => import('./cli-common.mjs').CliEvent[]}
 */
export function createParser() {
    return (event) => {
        if (event?.event === 'step_update') {
            const step = event.step_update || {};
            if (step.step_type === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta) {
                return [{ text: step.text_delta }];
            }
            return [];
        }
        if (event?.event !== 'result') return [];
        const result = event.result || {};
        if (result.status !== 'SUCCESS') {
            const message = result.error || `${LABEL} ended with status ${result.status || 'unknown'}`;
            return [{ error: message, status: statusForMessage(message), end: true }];
        }
        const usage = result.usage || {};
        return [{
            usage: {
                prompt: Number(usage.input_tokens) || 0,
                completion: Number(usage.output_tokens) || 0,
                cached: Number(usage.cache_read_tokens) || 0,
                reasoning: Number(usage.thinking_tokens) || 0,
            },
            finish: 'stop',
            end: true,
        }];
    };
}

/**
 * @param {string} model
 * @param {any} req
 * @returns {string[]}
 */
export function buildArgs(model, req) {
    return [
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--agent', AGENT_NAME,
        '--model', model,
        ...effortArgs(req),
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
    await writeIfChanged(agentFile(), AGENT_DEFINITION);
    const content = prompt.system
        ? `<system_instructions>\n${prompt.system}\n</system_instructions>\n\n${text}`
        : text;
    // One turn per process: stdin closes after the prompt, so agy exits once
    // it has answered.
    const input = `${JSON.stringify({ event: 'user', message: { content } })}\n`;
    return runCliChat({
        req,
        ctx,
        label: LABEL,
        executable: cli.path,
        args: buildArgs(ctx.model, req),
        env: cliEnv({ AGY_CLI_DISABLE_AUTO_UPDATE: '1' }),
        cwd,
        input,
        parse: createParser(),
    });
}

/**
 * `agy models` prints `slug<TAB>Display name` per line for the signed-in
 * account; it fails when agy is not signed in.
 * @param {string} stdout
 * @returns {{id:string, name:string}[]}
 */
export function parseModelList(stdout) {
    const models = [];
    for (const line of String(stdout || '').split(/\r?\n/)) {
        const [slug, name] = line.split('\t');
        if (slug && name && isValidModelId(slug.trim())) models.push({ id: slug.trim(), name: name.trim() });
    }
    return models;
}

export async function listModels(ctx) {
    const cli = ctx?.cli;
    if (!cli?.path) throw new Error(`${LABEL} (\`agy\`) is not installed`);
    const cwd = await prepareWorkDir(cli.workDir);
    const { code, stdout, stderr } = await runCliCommand(cli.path, ['models'], {
        cwd,
        env: cliEnv({ AGY_CLI_DISABLE_AUTO_UPDATE: '1' }),
        signal: ctx?.signal,
        label: LABEL,
    });
    if (code !== 0) throw new Error(summarizeStderr(stderr) || summarizeStderr(stdout) || `${LABEL} exited with code ${code}`);
    const models = parseModelList(stdout);
    if (models.length === 0) throw new Error(`${LABEL} listed no models; run \`agy\` in a terminal and sign in`);
    return models;
}

export default { id, chat, listModels };
