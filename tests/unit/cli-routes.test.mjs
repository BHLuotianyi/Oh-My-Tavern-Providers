import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// agy-cli writes its agent definition under the home folder; keep it in a sandbox.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omtp-cli-'));
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;

const { applyCliRoute, clearCliLookupCache } = await import('../../server-plugin/lib/cli-routes.mjs');
const { KeyStore } = await import('../../server-plugin/lib/key-store.mjs');
const { resolveProviderCredentials } = await import('../../server-plugin/lib/gateway-server.mjs');
const claude = await import('../../server-plugin/lib/adapters/claude-cli.mjs');
const agy = await import('../../server-plugin/lib/adapters/agy-cli.mjs');
const gemini = await import('../../server-plugin/lib/adapters/gemini-cli.mjs');
const { renderPrompt } = await import('../../server-plugin/lib/adapters/cli-common.mjs');

/**
 * A fake CLI: records argv, stdin and the system prompt it was given, then
 * replays `STUB_LINES` on stdout, `STUB_STDERR` on stderr and exits `STUB_EXIT`.
 */
const STUB = `#!/usr/bin/env node
const fs = require('node:fs');
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
    const argv = process.argv.slice(2);
    const fileArg = argv.indexOf('--system-prompt-file');
    const systemFile = fileArg >= 0 ? argv[fileArg + 1] : process.env.GEMINI_SYSTEM_MD;
    fs.writeFileSync(process.env.STUB_RECORD, JSON.stringify({
        argv,
        stdin,
        cwd: process.cwd(),
        system: systemFile ? fs.readFileSync(systemFile, 'utf8') : null,
    }));
    for (const line of JSON.parse(process.env.STUB_LINES || '[]')) process.stdout.write(JSON.stringify(line) + '\\n');
    if (process.env.STUB_STDERR) process.stderr.write(process.env.STUB_STDERR);
    process.exitCode = Number(process.env.STUB_EXIT || 0);
});
`;
const stubPath = path.join(sandbox, 'fake-cli');
fs.writeFileSync(stubPath, STUB, { mode: 0o755 });
const recordPath = path.join(sandbox, 'record.json');

function useStub({ lines = [], stderr = '', exit = 0 } = {}) {
    process.env.STUB_RECORD = recordPath;
    process.env.STUB_LINES = JSON.stringify(lines);
    process.env.STUB_STDERR = stderr;
    process.env.STUB_EXIT = String(exit);
    fs.rmSync(recordPath, { force: true });
}

const record = () => JSON.parse(fs.readFileSync(recordPath, 'utf8'));

function ctxFor(command, model, extra = {}) {
    return {
        provider: 'test',
        model,
        signal: null,
        catalogProvider: { models: [{ id: model, name: model }] },
        cli: { command, label: command, path: stubPath, workDir: path.join(sandbox, 'work', command) },
        ...extra,
    };
}

const CHAT = [
    { role: 'system', content: 'You are Captain Redbeard.' },
    { role: 'user', content: 'Ahoy' },
    { role: 'assistant', content: 'Arr!' },
    { role: 'user', content: 'Where to?' },
];

const skipOnWindows = { skip: process.platform === 'win32' ? 'stub CLI is a shebang script' : false };

test('subscription providers run through their CLI unless direct OAuth is switched on', () => {
    clearCliLookupCache();
    const env = { OMTP_AGY_PATH: stubPath };
    const stored = { id: 'google-antigravity', adapter: 'antigravity', apiKey: '{"access":"tok","refresh":"r"}', keySource: 'omtp', available: true };

    const routed = applyCliRoute(stored, sandbox, env);
    assert.equal(routed.adapter, 'agy-cli');
    assert.equal(routed.apiKey, '', 'the OAuth token never reaches the CLI route');
    assert.equal(routed.available, true);
    assert.equal(routed.cli.legacyCredential, true);
    assert.equal(routed.cli.workDir, path.join(sandbox, 'cli', 'agy'));

    const legacy = applyCliRoute({ ...stored, legacyOAuth: true }, sandbox, env);
    assert.equal(legacy.adapter, 'antigravity');
    assert.equal(legacy.apiKey, stored.apiKey);
});

test('a plain Anthropic API key keeps the direct API; subscription tokens do not', () => {
    clearCliLookupCache();
    const env = { OMTP_CLAUDE_PATH: stubPath };
    const apiKey = applyCliRoute({ id: 'anthropic', adapter: 'anthropic', apiKey: 'sk-ant-api03-x', keySource: 'st' }, sandbox, env);
    assert.equal(apiKey.adapter, 'anthropic');
    const oat = applyCliRoute({ id: 'anthropic', adapter: 'anthropic', apiKey: 'sk-ant-oat01-x', keySource: 'env' }, sandbox, env);
    assert.equal(oat.adapter, 'claude-cli');
    assert.equal(oat.cli.legacyCredential, false, 'an env token is not a stored sign-in');
    const none = applyCliRoute({ id: 'anthropic', adapter: 'anthropic', apiKey: '', keySource: 'none' }, sandbox, env);
    assert.equal(none.adapter, 'claude-cli');
});

test('a missing CLI leaves the provider unavailable with a reason', () => {
    clearCliLookupCache();
    const routed = applyCliRoute(
        { id: 'google-gemini-cli', adapter: 'antigravity', apiKey: '', keySource: 'none', available: false },
        sandbox,
        { OMTP_GEMINI_PATH: path.join(sandbox, 'missing-gemini') },
    );
    assert.equal(routed.adapter, 'gemini-cli');
    assert.equal(routed.available, false);
    assert.equal(routed.keySource, 'none');
    assert.equal(routed.cli.path, '');
});

test('the stored legacyOAuth switch decides the route end to end', async () => {
    clearCliLookupCache();
    const root = fs.mkdtempSync(path.join(sandbox, 'store-'));
    const store = new KeyStore({ root, resolveStSecret: () => '', env: { OMTP_AGY_PATH: stubPath } });
    const provider = { id: 'google-antigravity', label: 'Antigravity', gatewayAdapter: 'antigravity', baseUrl: 'https://daily-cloudcode-pa.googleapis.com', authKind: 'oauth', models: [] };
    await store.setProviderConfig('google-antigravity', { apiKey: '{"access":"tok"}' });

    let resolved = await resolveProviderCredentials(store, provider);
    assert.equal(resolved.adapter, 'agy-cli');
    assert.equal(resolved.legacyOAuth, false);

    await store.setProviderConfig('google-antigravity', { legacyOAuth: true });
    resolved = await resolveProviderCredentials(store, provider);
    assert.equal(resolved.adapter, 'antigravity');
    assert.equal(resolved.apiKey, '{"access":"tok"}');

    await store.setProviderConfig('google-antigravity', { legacyOAuth: false });
    assert.equal((await store.getProviderConfig('google-antigravity')).legacyOAuth, undefined);
});

test('the prompt keeps system text apart and asks to continue an unfinished assistant turn', () => {
    const prompt = renderPrompt([...CHAT, { role: 'assistant', content: 'We sail' }]);
    assert.equal(prompt.system, 'You are Captain Redbeard.');
    const text = prompt.blocks.map((block) => block.text).join('');
    assert.match(text, /<user>\nAhoy\n<\/user>\n\n<assistant>\nArr!\n<\/assistant>/);
    assert.match(text, /continue it from exactly where it stops/);
    assert.equal(renderPrompt([{ role: 'system', content: 'only system' }]), null);
});

test('claude-cli streams deltas into an OpenAI completion with usage', skipOnWindows, async () => {
    useStub({
        lines: [
            { type: 'system', subtype: 'init' },
            { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } },
            { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } },
            { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } },
            { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
            { type: 'result', subtype: 'success', is_error: false, result: 'Hello', stop_reason: 'end_turn', usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 7 } },
        ],
    });
    const response = await claude.chat({ messages: CHAT, reasoning_effort: 'high', temperature: 0.3 }, ctxFor('claude', 'claude-sonnet-5-5'));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, 'Hello', 'deltas are not doubled by the final assistant message');
    assert.equal(body.choices[0].message.reasoning_content, 'hmm');
    assert.deepEqual(
        { prompt: body.usage.prompt_tokens, completion: body.usage.completion_tokens, cached: body.usage.prompt_tokens_details.cached_tokens },
        { prompt: 17, completion: 7, cached: 5 },
    );

    const seen = record();
    assert.equal(seen.system, 'You are Captain Redbeard.');
    const tools = seen.argv.indexOf('--tools');
    assert.equal(seen.argv[tools + 1], '', 'all tools disabled');
    assert.ok(seen.argv.includes('--safe-mode'));
    assert.deepEqual(seen.argv.slice(seen.argv.indexOf('--effort'), seen.argv.indexOf('--effort') + 2), ['--effort', 'high']);
    const input = JSON.parse(seen.stdin);
    assert.equal(input.type, 'user');
    assert.match(input.message.content[0].text, /<user>\nWhere to\?\n<\/user>/);
    assert.equal(fs.readdirSync(path.join(sandbox, 'work', 'claude', '.omtp-requests')).length, 0, 'system prompt file removed');
});

test('claude-cli reports a signed-out CLI as a 401 before any text', skipOnWindows, async () => {
    useStub({
        lines: [
            { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } },
            { type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' },
        ],
        exit: 1,
    });
    const response = await claude.chat({ messages: CHAT, stream: true }, ctxFor('claude', 'claude-sonnet-5-5'));
    assert.equal(response.status, 401);
    assert.match((await response.json()).error.message, /Not logged in/);
});

test('agy-cli streams SSE and carries the system prompt inside the message', skipOnWindows, async () => {
    useStub({
        lines: [
            { event: 'init', conversation_id: 'c1', init: {} },
            { event: 'step_update', step_update: { step_type: 'user_input', state: 'DONE' } },
            { event: 'step_update', step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Arr' } },
            { event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE', text_delta: ', north!' } },
            { event: 'result', result: { status: 'SUCCESS', response: 'Arr, north!', usage: { input_tokens: 30, output_tokens: 4, thinking_tokens: 1, cache_read_tokens: 20 } } },
        ],
    });
    const response = await agy.chat({ messages: CHAT, stream: true }, ctxFor('agy', 'gemini-3.8-flash'));
    assert.equal(response.status, 200);
    const frames = (await response.text()).split('\n\n').filter(Boolean).map((frame) => frame.replace(/^data: /, ''));
    assert.equal(frames.at(-1), '[DONE]');
    const chunks = frames.slice(0, -1).map((frame) => JSON.parse(frame));
    assert.equal(chunks.map((chunk) => chunk.choices[0]?.delta?.content || '').join(''), 'Arr, north!');
    assert.equal(chunks.find((chunk) => chunk.choices[0]?.finish_reason)?.choices[0].finish_reason, 'stop');
    assert.equal(chunks.at(-1).usage.prompt_tokens, 30);

    const seen = record();
    assert.deepEqual(seen.argv.slice(seen.argv.indexOf('--agent'), seen.argv.indexOf('--agent') + 2), ['--agent', agy.AGENT_NAME]);
    const content = JSON.parse(seen.stdin).message.content;
    assert.match(content, /^<system_instructions>\nYou are Captain Redbeard\.\n<\/system_instructions>/);
    const agentFile = path.join(sandbox, '.gemini', 'config', 'agents', `${agy.AGENT_NAME}.md`);
    assert.match(fs.readFileSync(agentFile, 'utf8'), /excludeDefaultComponents: true/);
});

test('agy-cli rejects images instead of dropping them', async () => {
    const response = await agy.chat({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
    }, ctxFor('agy', 'gemini-3.8-flash'));
    assert.equal(response.status, 400);
});

test('claude-cli listModels reads the signed-out status even though the CLI exits 1', skipOnWindows, async () => {
    useStub({ lines: [{ loggedIn: false, authMethod: 'none' }], exit: 1 });
    await assert.rejects(claude.listModels(ctxFor('claude', 'claude-sonnet-5-5')), /not signed in \(HTTP 401\)/);
    useStub({ lines: [{ loggedIn: true, authMethod: 'claude.ai' }] });
    assert.deepEqual(await claude.listModels(ctxFor('claude', 'claude-sonnet-5-5')), [{ id: 'claude-sonnet-5-5', name: 'claude-sonnet-5-5' }]);
    assert.deepEqual(record().argv, ['auth', 'status', '--json']);
});

test('agy-cli lists the signed-in account models', () => {
    assert.deepEqual(
        agy.parseModelList('Fetching available models...\ngemini-4-argon-high\tGemini 4 Argon (High)\nclaude-opus-5-5-low\tClaude Opus 5.5 (Low)\n'),
        [{ id: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' }, { id: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)' }],
    );
});

test('gemini-cli turns a suspended account into a 403 from stderr', skipOnWindows, async () => {
    useStub({
        stderr: 'Warning: Basic terminal detected (TERM=dumb).\nError authenticating: _GaxiosError: This service has been disabled in this account for violation of Terms of Service.\n    at Gaxios._request (file:///x.js:1:1)\n',
        exit: 1,
    });
    const response = await gemini.chat({ messages: CHAT }, ctxFor('gemini', 'gemini-2.5-flash'));
    assert.equal(response.status, 403);
    assert.match((await response.json()).error.message, /disabled in this account/);

    const seen = record();
    assert.equal(seen.system, 'You are Captain Redbeard.');
    assert.ok(seen.argv.includes('--skip-trust'));
    const settings = JSON.parse(fs.readFileSync(path.join(seen.cwd, '.gemini', 'settings.json'), 'utf8'));
    assert.deepEqual(settings.tools.core, [], 'no built-in tools');
});

test('gemini-cli maps message deltas and result stats', skipOnWindows, async () => {
    useStub({
        lines: [
            { type: 'init', session_id: 's', model: 'gemini-2.5-flash' },
            { type: 'message', role: 'user', content: 'ignored' },
            { type: 'message', role: 'assistant', content: 'Fair ', delta: true },
            { type: 'message', role: 'assistant', content: 'winds.', delta: true },
            { type: 'result', status: 'success', stats: { input_tokens: 12, output_tokens: 3, cached: 4 } },
        ],
    });
    const body = await (await gemini.chat({ messages: CHAT }, ctxFor('gemini', 'gemini-2.5-flash'))).json();
    assert.equal(body.choices[0].message.content, 'Fair winds.');
    assert.equal(body.usage.prompt_tokens, 12);
    assert.equal(body.usage.completion_tokens, 3);
});

test('CLI adapters refuse model ids that are not plain slugs', async () => {
    const response = await claude.chat({ messages: CHAT }, ctxFor('claude', 'x; rm -rf /'));
    assert.equal(response.status, 400);
});
