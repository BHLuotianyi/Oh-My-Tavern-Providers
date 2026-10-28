/**
 * `kilo` login hook.
 *
 * OMP port: `packages/ai/src/registry/oauth/kilo.ts`. Kilo runs its own device
 * authorization (no RFC 8628 fields), so it needs provider code rather than a
 * compiled policy. The issued token is a durable bearer, so we store it as a
 * plain key instead of a structured OAuth credential.
 */

const BASE_URL = 'https://api.kilo.ai/api/device-auth';
const POLL_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * @param {{doFetch?: typeof fetch, signal?: AbortSignal}} deps
 */
export async function startKilo({ doFetch = fetch, signal } = {}) {
    const initiate = await doFetch(`${BASE_URL}/codes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!initiate.ok) {
        const detail = initiate.status === 429
            ? 'Too many pending authorization requests — try again later'
            : `Device authorization failed: HTTP ${initiate.status}`;
        throw new Error(detail);
    }
    const grant = await initiate.json();
    const userCode = String(grant?.code || '');
    const verificationUrl = String(grant?.verificationUrl || '');
    const expiresIn = Number(grant?.expiresIn);
    if (!userCode || !verificationUrl || !(expiresIn > 0)) {
        throw new Error('Device authorization response missing code/verificationUrl/expiresIn');
    }

    return {
        url: verificationUrl,
        userCode,
        instructions: `Enter code: ${userCode}`,
        async waitForCompletion({ signal: inner } = {}) {
            const cancel = inner || signal;
            const deadline = Date.now() + expiresIn * 1000;
            while (Date.now() < deadline) {
                if (cancel?.aborted) throw new Error('Login canceled');
                const response = await doFetch(`${BASE_URL}/codes/${encodeURIComponent(userCode)}`, {
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                });
                if (response.status === 202) {
                    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
                    continue;
                }
                if (response.status === 403) throw new Error('Authorization was denied');
                if (response.status === 410) throw new Error('Authorization code expired — try again');
                if (!response.ok) {
                    throw new Error(`Device polling failed: HTTP ${response.status}`);
                }
                const data = await response.json();
                if (data?.status === 'approved' && data.token) {
                    return { type: 'api-key', access: String(data.token) };
                }
                if (data?.status === 'denied') throw new Error('Authorization was denied');
                if (data?.status === 'expired') throw new Error('Authorization code expired — try again');
                await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
            }
            throw new Error('Authentication timed out');
        },
    };
}

export const HOOKS = { kilo: startKilo };
