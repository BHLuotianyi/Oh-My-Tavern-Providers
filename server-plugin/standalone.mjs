#!/usr/bin/env node
/**
 * OMTP companion: the server plugin without SillyTavern, for hosts that cannot
 * run Node server plugins (TauriTavern). It serves the same management routes
 * under `/api/plugins/omtp` on its own port and starts the same gateway.
 *
 *   node standalone.mjs [--data DIR] [--host 127.0.0.1] [--port 4099]
 *
 * Management calls arrive cross-origin from the TauriTavern WebView, so they
 * are authorised by the companion token (printed at startup, stored in
 * `<data>/omtp/companion-token`) instead of SillyTavern's session.
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import miniExpress from './lib/mini-express.mjs';
import { ensureCompanionToken, ensureOmtpRoot, getOmtpRoot, tokensEqual } from './lib/config.mjs';
import { CLIENT_HEADER, CLIENT_HEADER_VALUE } from './lib/client-guard.mjs';
import { init, exit } from './lib/plugin.mjs';
import { log, logError } from './lib/redact.mjs';

export const COMPANION_TOKEN_HEADER = 'x-omtp-token';
const DEFAULT_PORT = 4099;

const { values: args } = parseArgs({
    options: {
        data: { type: 'string' },
        host: { type: 'string', default: '127.0.0.1' },
        port: { type: 'string', default: String(DEFAULT_PORT) },
        help: { type: 'boolean', short: 'h' },
    },
});

if (args.help) {
    console.log(`Usage: node standalone.mjs [--data DIR] [--host ADDRESS] [--port PORT]

  --data   Data directory; OMTP state goes to DIR/omtp (default ~/.omtp-companion).
           Point it at SillyTavern/data to share keys with a SillyTavern install.
  --host   Interface for the companion and the gateway (default 127.0.0.1).
           Use 0.0.0.0 only to reach it from another device on a trusted LAN.
  --port   Companion port (default ${DEFAULT_PORT}). The gateway keeps its own port (4100).`);
    process.exit(0);
}

const port = Number(args.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid --port: ${args.port}`);
    process.exit(2);
}

globalThis.DATA_ROOT = path.resolve(args.data || path.join(os.homedir(), '.omtp-companion'));
const root = getOmtpRoot();
await ensureOmtpRoot(root);
const token = await ensureCompanionToken(root);

/**
 * Same intent as the plugin's client guard, keyed to the token: the WebView
 * origin differs from ours by design, so Origin checks cannot apply.
 * @param {any} req
 */
function checkCompanionClient(req) {
    if (req.headers[CLIENT_HEADER] !== CLIENT_HEADER_VALUE) return { ok: false, reason: 'missing client header' };
    if (!tokensEqual(String(req.headers[COMPANION_TOKEN_HEADER] || ''), token)) return { ok: false, reason: 'invalid companion token' };
    return { ok: true };
}

const app = miniExpress();

// CORS for the WebView. Every management route still needs the token, so the
// origin is echoed rather than allow-listed (TauriTavern's origin differs per platform).
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'content-type');
        res.setHeader('Access-Control-Max-Age', '600');
        if (req.headers['access-control-request-private-network']) {
            res.setHeader('Access-Control-Allow-Private-Network', 'true');
        }
        res.statusCode = 204;
        res.end();
        return;
    }
    next();
});

app.get('/health', (req, res) => {
    res.json({ ok: true, service: 'omtp-companion' });
});

app.use(miniExpress.json({ limit: '50mb' }));

const router = miniExpress.Router();
await init(router, { express: miniExpress, checkClient: checkCompanionClient, gatewayHost: args.host });
app.use('/api/plugins/omtp', router);

const server = http.createServer(app);
server.requestTimeout = 0;
server.on('error', (error) => {
    logError(`companion could not listen on ${args.host}:${port}`, error);
    process.exit(1);
});
server.listen(port, args.host, () => {
    const shown = args.host === '0.0.0.0' ? '<this machine\'s address>' : args.host;
    log(`companion ready at http://${shown}:${port}`);
    log(`data directory: ${root}`);
    console.log(`\nIn OMTP settings (TauriTavern), set:\n  Companion address: http://${shown}:${port}\n  Companion token:   ${token}\n`);
});

let stopping = false;
async function shutdown() {
    if (stopping) return;
    stopping = true;
    server.close();
    await exit().catch((error) => logError('shutdown failed', error));
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
