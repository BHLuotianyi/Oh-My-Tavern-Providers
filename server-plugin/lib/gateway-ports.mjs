/**
 * Port acquisition for the standalone gateway listener.
 *
 * A configured port may already belong to another OMTP gateway. `/health` is
 * unauthenticated, so every instance answers it — including one owned by a
 * different SillyTavern installation, whose `gateway-token` differs. Reusing
 * such a listener would report `running: true` while every forwarded request
 * fails with 401, so a health handshake alone is not enough.
 */

const PROBE_TIMEOUT_MS = 1200;

/**
 * @param {number} port
 * @returns {Promise<any|null>}
 */
async function probeHealth(port) {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!response.ok) return null;
        return await response.json();
    } catch {
        return null;
    }
}

/**
 * Ask an existing gateway to serve `/v1/models` with this instance's token.
 * @param {number} port
 * @param {string} token
 * @returns {Promise<boolean>}
 */
async function probeModelsAuth(port, token) {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        return response.status === 200;
    } catch {
        return false;
    }
}

/**
 * Bind the first usable port, reusing a running gateway only when it accepts
 * this instance's token.
 *
 * @param {object} options
 * @param {number[]} options.ports Candidates in preference order.
 * @param {(port: number) => Promise<void>} options.listen Binds the listener.
 * @param {string} [options.token] This instance's gateway token.
 * @param {boolean} [options.requireAuth] Whether the gateway enforces the token.
 * @returns {Promise<{port:number, external:boolean}>}
 */
export async function acquireGatewayPort({ ports, listen, token = '', requireAuth = true }) {
    let lastError = null;
    for (const port of ports) {
        try {
            await listen(port);
            return { port, external: false };
        } catch (error) {
            if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EADDRINUSE') {
                const health = await probeHealth(port);
                if (health?.service === 'omtp-gateway') {
                    // Without auth enforcement any OMTP gateway is compatible;
                    // otherwise it must accept the token we forward with.
                    if (!requireAuth || await probeModelsAuth(port, token)) {
                        return { port, external: true };
                    }
                    lastError = `Gateway port ${port} is owned by another OMTP instance with a different token`;
                    continue;
                }
            }
            lastError = `Gateway port ${port} unavailable: ${error instanceof Error ? error.message : String(error)}`;
        }
    }
    throw new Error(lastError || 'Gateway port unavailable');
}
