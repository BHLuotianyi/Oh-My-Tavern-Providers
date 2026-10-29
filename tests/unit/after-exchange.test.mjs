import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAfterExchange } from '../../server-plugin/lib/after-exchange.mjs';

/** @param {unknown} body */
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

/** @param {Record<string, unknown>} payload */
const jwt = (payload) => `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

function credential(overrides = {}) {
    return {
        type: 'oauth',
        provider: 'test',
        access: 'access-token',
        refresh: 'refresh-token',
        ...overrides,
    };
}

test('unknown and empty after-exchange hooks leave the credential unchanged', async () => {
    const original = credential();
    assert.equal(await applyAfterExchange('not-a-real-hook', original), original);
    assert.equal(await applyAfterExchange('', original), original);
    assert.equal(await applyAfterExchange(undefined, original), original);
});

test('gitlab-duo-clear-cache is an explicit no-op', async () => {
    const original = credential();
    assert.equal(await applyAfterExchange('gitlab-duo-clear-cache', original), original);
});

test('anthropic-identity fills account and organization identity from bootstrap', async () => {
    const calls = [];
    const doFetch = async (url, init) => {
        calls.push({ url: String(url), headers: init.headers });
        return json({
            oauth_account: {
                account_uuid: 'acct-1',
                account_email: 'user@example.com',
                organization_uuid: 'org-1',
                organization_name: 'Team',
            },
        });
    };
    const enriched = await applyAfterExchange('anthropic-identity', credential(), {
        provider: 'anthropic',
        fetch: doFetch,
        env: { PI_AI_CLAUDE_CODE_VERSION: '9.9.9' },
    });

    assert.equal(enriched.accountId, 'acct-1');
    assert.equal(enriched.email, 'user@example.com');
    assert.equal(enriched.orgId, 'org-1');
    assert.equal(enriched.orgName, 'Team');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^https:\/\/api\.anthropic\.com\/api\/claude_cli\/bootstrap\?entrypoint=cli&model=/);
    assert.equal(calls[0].headers.Authorization, 'Bearer access-token');
    assert.equal(calls[0].headers['anthropic-beta'], 'oauth-2025-04-20');
    assert.equal(calls[0].headers['User-Agent'], 'claude-code/9.9.9');
});

test('anthropic-identity keeps the credential when bootstrap fails', async () => {
    const original = credential();
    const httpFailure = await applyAfterExchange('anthropic-identity', original, {
        fetch: async () => new Response('no bootstrap for you', { status: 500 }),
    });
    assert.deepEqual(httpFailure, original);

    const networkFailure = await applyAfterExchange('anthropic-identity', original, {
        fetch: async () => { throw new TypeError('fetch failed'); },
    });
    assert.deepEqual(networkFailure, original);
});

test('anthropic-identity does not refetch a complete identity', async () => {
    const original = credential({ accountId: 'acct', email: 'user@example.com', orgId: 'org' });
    const enriched = await applyAfterExchange('anthropic-identity', original, {
        fetch: async () => { throw new Error('must not call the network'); },
    });
    assert.equal(enriched, original);
});

test('openai-codex-profile decodes account identity from token claims', async () => {
    const access = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-9' } });
    const idToken = jwt({
        'https://api.openai.com/auth': { chatgpt_plan_type: 'Plus' },
        'https://api.openai.com/profile': { email: 'User@Example.com' },
    });
    const enriched = await applyAfterExchange('openai-codex-profile', credential({ access }), {
        provider: 'openai-codex',
        raw: { id_token: idToken },
    });
    assert.equal(enriched.accountId, 'acct-9');
    assert.equal(enriched.email, 'user@example.com');
    assert.equal(enriched.orgId, 'acct-9');
    assert.equal(enriched.orgName, 'plus');
});

test('openai-codex-profile rejects a login token without identity', async () => {
    await assert.rejects(
        applyAfterExchange('openai-codex-profile', credential({ access: 'opaque-token' }), {
            provider: 'openai-codex',
            raw: {},
        }),
        /Failed to extract account identity/,
    );
});

test('zai-mint-key provisions the durable key through the business APIs', async () => {
    const calls = [];
    const doFetch = async (url, init) => {
        const href = String(url);
        calls.push({
            url: href,
            method: init?.method || 'GET',
            body: init?.body ? String(init.body) : '',
            authorization: init?.headers?.Authorization || '',
        });
        if (href === 'https://api.z.ai/api/auth/z/login') {
            return json({ code: 200, data: { access_token: 'biz-token' } });
        }
        if (href === 'https://api.z.ai/api/biz/customer/getCustomerInfo') {
            return json({
                code: 200,
                data: {
                    organizations: [{
                        organizationId: 'org-1',
                        isDefault: true,
                        projects: [{ projectId: 'proj-1', isDefault: true }],
                    }],
                },
            });
        }
        if (href === 'https://api.z.ai/api/biz/v1/organization/org-1/projects/proj-1/api_keys') {
            return init?.method === 'POST'
                ? json({ code: 200, data: { apiKey: 'key-1' } })
                : json({ code: 200, data: { list: [] } });
        }
        if (href === 'https://api.z.ai/api/biz/v1/organization/org-1/projects/proj-1/api_keys/copy/key-1') {
            return json({ code: 200, data: { secretKey: 'secret-1' } });
        }
        throw new Error(`unexpected ${href}`);
    };

    const enriched = await applyAfterExchange('zai-mint-key', credential(), {
        provider: 'zai-coding-plan',
        fetch: doFetch,
        env: {},
    });

    assert.equal(enriched.access, 'key-1.secret-1');
    assert.equal(enriched.refresh, 'refresh-token');
    const login = calls.find((call) => call.url.endsWith('/api/auth/z/login'));
    assert.deepEqual(JSON.parse(login.body), { token: 'access-token' });
    // The minted sequence authenticates with the business token, never the
    // short-lived OAuth access token.
    for (const call of calls.slice(1)) {
        assert.equal(call.authorization, 'Bearer biz-token');
    }
    const created = calls.find((call) => call.method === 'POST' && call.url.endsWith('/api_keys'));
    assert.equal(JSON.parse(created.body).name, 'oh-my-pi');
});

test('zai-mint-key reuses an existing key instead of creating another', async () => {
    const created = [];
    const doFetch = async (url, init) => {
        const href = String(url);
        if (href.endsWith('/api/auth/z/login')) return json({ success: true, data: { accessToken: 'biz-token' } });
        if (href.endsWith('/getCustomerInfo')) {
            return json({ success: true, data: { organizations: [{ organizationId: 'org', projects: [{ projectId: 'proj' }] }] } });
        }
        if (href.endsWith('/api_keys')) {
            if (init?.method === 'POST') {
                created.push(href);
                return json({ success: true, data: { apiKey: 'new-key' } });
            }
            return json({ success: true, data: { keys: [{ name: 'oh-my-pi', apiKey: 'reused-key' }] } });
        }
        if (href.endsWith('/copy/reused-key')) return json({ success: true, data: { secretKey: 'reused-secret' } });
        throw new Error(`unexpected ${href}`);
    };
    const enriched = await applyAfterExchange('zai-mint-key', credential(), { fetch: doFetch, env: {} });
    assert.equal(enriched.access, 'reused-key.reused-secret');
    assert.deepEqual(created, []);
});

test('zai-mint-key surfaces envelope failures', async () => {
    await assert.rejects(
        applyAfterExchange('zai-mint-key', credential(), {
            fetch: async () => json({ code: 401, msg: 'invalid token' }),
        }),
        /Z\.ai business login failed: invalid token/,
    );
});

test('muse-code-key attaches the subscription key and reuses an existing one', async () => {
    const calls = [];
    const doFetch = async (url, init) => {
        calls.push({ url: String(url), headers: init.headers, body: init.body });
        return json({ api_key: 'muse-key', user_email: 'User@Example.com', user_id: 'u-1', is_subs_active: true });
    };
    const credentialValue = credential({ access: 'oauth-token' });
    const enriched = await applyAfterExchange('muse-code-key', credentialValue, { fetch: doFetch });

    // `access` must be the request bearer; the Meta token is preserved beside it.
    assert.equal(enriched.access, 'muse-key');
    assert.equal(enriched.oauthAccessToken, 'oauth-token');
    assert.equal(enriched.accountId, 'u-1');
    assert.equal(enriched.email, 'user@example.com');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.meta.ai/muse-code/key');
    assert.equal(calls[0].headers['x-api-version'], '1.0.0');
    assert.equal(calls[0].headers.Authorization, 'Bearer oauth-token');
    assert.equal(calls[0].body, '{"onboard":true}');

    // A refresh that already carries the minted key must not burn another call.
    const reused = await applyAfterExchange('muse-code-key', enriched, {
        fetch: async () => { throw new Error('must not call the network'); },
    });
    assert.equal(reused, enriched);
});

test('muse-code-key normalizes an OMP-shaped stored credential without re-minting', async () => {
    const ompShape = credential({ access: JSON.stringify({ oauthAccessToken: 'oauth-token', apiKey: 'muse-key' }) });
    const normalized = await applyAfterExchange('muse-code-key', ompShape, {
        fetch: async () => { throw new Error('must not call the network'); },
    });
    assert.equal(normalized.access, 'muse-key');
    assert.equal(normalized.oauthAccessToken, 'oauth-token');
});

test('muse-code-key explains an inactive subscription', async () => {
    await assert.rejects(
        applyAfterExchange('muse-code-key', credential(), {
            fetch: async () => json({ is_subs_active: false }),
        }),
        /subscription is inactive/,
    );
});

test('google-gemini-cli-project keeps the project the account already has', async () => {
    const calls = [];
    const doFetch = async (url, init) => {
        calls.push({ url: String(url), headers: init.headers });
        return json({ currentTier: { id: 'standard-tier' }, cloudaicompanionProject: 'proj-9' });
    };
    const enriched = await applyAfterExchange('google-gemini-cli-project', credential(), {
        provider: 'google-gemini-cli',
        raw: { refresh_token: 'refresh' },
        env: {},
        fetch: doFetch,
    });
    assert.equal(enriched.projectId, 'proj-9');
    assert.equal(calls[0].url, 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist');
    assert.match(calls[0].headers['User-Agent'], /^GeminiCLI\//);
    assert.equal(calls[0].headers['Client-Metadata'], 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI');
});

test('google-gemini-cli-project preserves the stored project on refresh', async () => {
    const enriched = await applyAfterExchange('google-gemini-cli-project', credential(), {
        phase: 'refresh',
        stored: { projectId: 'proj-stored' },
        fetch: async () => { throw new Error('must not call the network'); },
    });
    assert.equal(enriched.projectId, 'proj-stored');
});

test('google-antigravity-project resolves the Cloud Code Assist project', async () => {
    const calls = [];
    const doFetch = async (url, init) => {
        calls.push({ url: String(url), headers: init.headers });
        return json({ currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'proj-antigravity' });
    };
    const enriched = await applyAfterExchange('google-antigravity-project', credential(), {
        provider: 'google-antigravity',
        raw: { refresh_token: 'refresh' },
        env: {},
        fetch: doFetch,
    });
    assert.equal(enriched.projectId, 'proj-antigravity');
    assert.equal(calls[0].url, 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist');
    assert.match(calls[0].headers['User-Agent'], /^antigravity\/hub\//);
    // A project without a paid tier is re-queried before discovery completes.
    assert.ok(calls.length >= 2);
    assert.ok(calls.every((call) => call.url.endsWith('/v1internal:loadCodeAssist')));
});

test('google-gemini-cli-project requires a refresh token at login', async () => {
    await assert.rejects(
        applyAfterExchange('google-gemini-cli-project', credential(), {
            raw: {},
            fetch: async () => { throw new Error('must not call the network'); },
        }),
        /No refresh token received/,
    );
});

test('factory-droid-region records the organization and inference scope', async () => {
    const enriched = await applyAfterExchange('factory-droid-region', credential(), {
        provider: 'factory-droid',
        raw: { refresh_token: 'refresh', organization_id: 'org-7' },
        fetch: async () => json({ orgId: 'org-7', region: 'eu', inferenceRegion: 'global' }),
    });
    assert.equal(enriched.orgId, 'org-7');
    assert.equal(enriched.activeOrganizationId, 'org-7');
    assert.equal(enriched.region, 'eu');
    assert.equal(enriched.inferenceRegion, 'global');
});
