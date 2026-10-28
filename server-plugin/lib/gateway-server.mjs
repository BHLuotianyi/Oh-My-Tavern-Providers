import http from 'node:http';
import { Readable, Transform } from 'node:stream';
import express from 'express';
import {
    ensureGatewayToken,
    getOmtpRoot,
    loadConfig,
    saveConfig,
    tokensEqual,
} from './config.mjs';
import { buildProviderContext } from './provider-config.mjs';
import { resolveAccessToken } from './oauth.mjs';
import { openAIErrorEnvelope } from './sse.mjs';
import { log, logError } from './redact.mjs';
import { getAdapter } from './adapters/index.mjs';
import { createUsageTap, tokensFromOpenAIUsage } from './stats.mjs';

const GATEWAY_VERSION = '0.1.0';
const FALLBACK_PORTS = Object.freeze([4100, 4101, 4102, 4103, 4104, 4105, 4106, 4107, 4108, 4109, 4110]);

/**
 * @param {string} modelRef
 * @returns {{provider:string, model:string}|null}
 */
function splitModelRef(modelRef) {
    if (typeof modelRef !== 'string') return null;
    const trimmed = modelRef.trim();
    const separator = trimmed.indexOf('/');
    if (separator <= 0 || separator === trimmed.length - 1) return null;
    return { provider: trimmed.slice(0, separator), model: trimmed.slice(separator + 1) };
}

/**
 * @param {number} port
 * @returns {Promise<any|null>}
 */
async function probeHealth(port) {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(1200),
        });
        if (!response.ok) return null;
        return await response.json();
    } catch {
        return null;
    }
}

/**
 * Wrap an async route so rejections reach Express's error middleware.
 * @param {any} fn
 * @returns {any}
 */
export function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

/**
 * Standalone OpenAI-compatible gateway listener. Never mounted on ST's app.
 */
export class GatewayServer {
    /**
     * @param {{root?:string, catalogService:any, keyStore:any, stats?:any, adapterResolver?:(id:string)=>Promise<any>}} options
     */
    constructor(options) {
        this.root = options.root || getOmtpRoot();
        this.catalogService = options.catalogService;
        this.keyStore = options.keyStore;
        this.stats = options.stats || null;
        this.adapterResolver = options.adapterResolver || getAdapter;
        /** @type {http.Server|null} */
        this.server = null;
        this.running = false;
        this.external = false;
        this.port = 4100;
        this.requireAuth = true;
        this.token = '';
        /** @type {string|null} */
        this.lastError = null;
        /** @type {Set<AbortController>} */
        this._inflight = new Set();
    }

    /**
     * @returns {{running:boolean, url:string, port:number, requireAuth:boolean, lastError:string|null, external:boolean}}
     */
    getStatus() {
        return {
            running: this.running,
            url: this.running ? `http://127.0.0.1:${this.port}/v1` : '',
            port: this.port,
            requireAuth: this.requireAuth,
            lastError: this.lastError,
            external: this.external,
        };
    }

    /**
     * @returns {Promise<{running:boolean, url:string, port:number, requireAuth:boolean, lastError:string|null, external:boolean}>}
     */
    async start() {
        if (this.server) return this.getStatus();
        this.lastError = null;
        let config = { autoStart: true, port: 4100, requireAuth: true };
        try {
            config = await loadConfig(this.root);
        } catch (error) {
            logError('failed to load gateway config; using defaults', error);
        }
        this.requireAuth = config.requireAuth !== false;
        this.port = config.port;

        try {
            this.token = await ensureGatewayToken(this.root);
        } catch (error) {
            this.lastError = `Gateway token unavailable: ${error instanceof Error ? error.message : String(error)}`;
            logError('gateway token unavailable', error);
        }
        if (this.requireAuth && !this.token) {
            this.running = false;
            logError('gateway not started', new Error(this.lastError || 'Gateway token unavailable'));
            return this.getStatus();
        }

        const ports = [...new Set([config.port, ...FALLBACK_PORTS])].filter((port) => port >= 1 && port <= 65535);
        for (const port of ports) {
            try {
                await this._listen(port);
                this.port = port;
                this.running = true;
                this.external = false;
                this.lastError = null;
                if (port !== config.port) {
                    await saveConfig(this.root, { port }).catch((error) => logError('failed to persist gateway port', error));
                }
                log(`gateway listening on 127.0.0.1:${port}`);
                return this.getStatus();
            } catch (error) {
                if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EADDRINUSE') {
                    const health = await probeHealth(port);
                    if (health?.service === 'omtp-gateway') {
                        this.port = port;
                        this.running = true;
                        this.external = true;
                        this.lastError = null;
                        log(`reusing existing OMTP gateway on 127.0.0.1:${port}`);
                        return this.getStatus();
                    }
                }
                this.lastError = `Gateway port ${port} unavailable: ${error instanceof Error ? error.message : String(error)}`;
            }
        }

        this.running = false;
        this.lastError = this.lastError || 'Gateway port unavailable';
        logError('gateway failed to start', new Error(this.lastError));
        return this.getStatus();
    }

    /**
     * @param {number} port
     * @returns {Promise<void>}
     */
    async _listen(port) {
        const app = this._buildApp();
        const server = http.createServer(app);
        await new Promise((resolve, reject) => {
            /** @param {Error} error */
            const onError = (error) => {
                server.off('listening', onListening);
                server.close(() => {});
                reject(error);
            };
            const onListening = () => {
                server.off('error', onError);
                resolve(undefined);
            };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(port, '127.0.0.1');
        });
        server.requestTimeout = 0;
        server.headersTimeout = 65_000;
        server.timeout = 0;
        this.server = server;
    }

    /**
     * @returns {Promise<void>}
     */
    async stop() {
        for (const controller of this._inflight) {
            try {
                controller.abort();
            } catch {
                // Ignore.
            }
        }
        this._inflight.clear();
        const server = this.server;
        this.server = null;
        this.running = false;
        this.external = false;
        if (!server) return;
        const closed = new Promise((resolve) => server.close(() => resolve(undefined)));
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
        await closed;
    }

    /**
     * @returns {Promise<any>}
     */
    async restart() {
        await this.stop();
        return this.start();
    }

    /**
     * @returns {import('express').Express}
     */
    _buildApp() {
        const app = express();
        app.disable('x-powered-by');
        app.use(express.json({ limit: '50mb' }));

        app.get('/health', asyncHandler(async (req, res) => {
            let catalogVersion = 'unknown';
            try {
                const stats = await this.catalogService.stats();
                catalogVersion = stats.version;
            } catch {
                // Catalog may be unavailable while starting; health still works.
            }
            res.json({
                ok: true,
                service: 'omtp-gateway',
                version: GATEWAY_VERSION,
                catalogVersion,
            });
        }));

        app.use('/v1', this._authMiddleware());
        app.get('/v1/models', asyncHandler((req, res) => this._handleModels(req, res)));
        app.post('/v1/chat/completions', asyncHandler((req, res) => this._handleChat(req, res)));

        app.use((req, res) => {
            res.status(404).json(openAIErrorEnvelope('Not found', 'invalid_request_error', 'not_found'));
        });
        // eslint-disable-next-line no-unused-vars
        app.use((error, req, res, next) => {
            const status = Number(error?.status) || 500;
            const message = error instanceof Error ? error.message : 'Gateway error';
            if (status >= 500) logError('gateway request failed', error);
            if (res.headersSent) {
                res.end();
                return;
            }
            res.status(status).json(openAIErrorEnvelope(message, error?.type || 'gateway_error', error?.code || null));
        });
        return app;
    }

    /**
     * @returns {import('express').RequestHandler}
     */
    _authMiddleware() {
        return (req, res, next) => {
            if (!this.requireAuth) {
                next();
                return;
            }
            const header = String(req.headers.authorization || '');
            const match = /^Bearer\s+(.+)$/i.exec(header.trim());
            const token = match ? match[1].trim() : '';
            if (!tokensEqual(token, this.token)) {
                res.status(401).json(openAIErrorEnvelope('Invalid or missing gateway token', 'authentication_error', 'invalid_api_key'));
                return;
            }
            next();
        };
    }

    /**
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     */
    async _handleModels(req, res) {
        const rows = await this.catalogService.getModelsForGateway();
        const data = rows.map(({ provider, model, adapter }) => ({
            id: `${provider.id}/${model.id}`,
            object: 'model',
            owned_by: provider.id,
            display_name: model.name || model.id,
            context_length: model.contextWindow ?? null,
            max_output_tokens: model.maxTokens ?? null,
            input_modalities: Array.isArray(model.input) ? model.input : ['text'],
            supports_tools: Boolean(model.supportsTools),
            omtp: { adapter, available: true, auth: 'omtp' },
        }));
        res.json({ object: 'list', data });
    }

    /**
     * Validate a chat request and resolve the adapter. Writes the error
     * response and returns null when the request cannot be forwarded.
     *
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @returns {Promise<{ref:any, catalogProvider:any, resolved:any, modelInfo:any, adapter:any}|null>}
     */
    async _resolveChat(req, res) {
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            res.status(400).json(openAIErrorEnvelope('Request body must be a JSON object', 'invalid_request_error', 'invalid_body'));
            return null;
        }
        const ref = splitModelRef(body.model);
        if (!ref) {
            res.status(400).json(openAIErrorEnvelope('Invalid model; expected provider/model', 'invalid_request_error', 'invalid_model'));
            return null;
        }
        if (!Array.isArray(body.messages)) {
            res.status(400).json(openAIErrorEnvelope('messages must be an array', 'invalid_request_error', 'invalid_messages'));
            return null;
        }

        const catalogProvider = await this.catalogService.getProvider(ref.provider);
        if (!catalogProvider) {
            res.status(404).json(openAIErrorEnvelope(`Unknown provider: ${ref.provider}`, 'invalid_request_error', 'model_not_found'));
            return null;
        }
        const resolved = await this.keyStore.resolveProvider(catalogProvider);
        if (!resolved.adapter) {
            res.status(400).json(openAIErrorEnvelope(
                `Provider ${ref.provider} is not supported by the OMTP gateway${catalogProvider.unsupportedReason ? ` (${catalogProvider.unsupportedReason})` : ''}`,
                'invalid_request_error',
                'unsupported_provider',
            ));
            return null;
        }
        // Live-discovered models (provider /models) are not in the bundled
        // catalog; forward them with minimal metadata.
        const modelInfo = (catalogProvider.models || []).find((model) => model.id === ref.model)
            || (resolved.models || []).find((model) => model.id === ref.model)
            || { id: ref.model, name: ref.model };
        if (!resolved.baseUrl) {
            res.status(400).json(openAIErrorEnvelope(`Provider ${ref.provider} has no base URL`, 'invalid_request_error', 'invalid_provider_config'));
            return null;
        }
        if (!resolved.available) {
            res.status(401).json(openAIErrorEnvelope(
                `Missing API key for ${resolved.label || ref.provider}`,
                'authentication_error',
                'missing_api_key',
            ));
            return null;
        }

        const adapter = await this.adapterResolver(resolved.adapter);
        if (!adapter) {
            res.status(400).json(openAIErrorEnvelope(
                `Gateway adapter '${resolved.adapter}' is unavailable`,
                'invalid_request_error',
                'unsupported_provider',
            ));
            return null;
        }
        return { ref, catalogProvider, resolved, modelInfo, adapter };
    }

    /**
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     */
    async _handleChat(req, res) {
        const target = await this._resolveChat(req, res);
        if (!target) return;
        const { ref, catalogProvider, resolved, modelInfo, adapter } = target;

        const controller = new AbortController();
        this._inflight.add(controller);
        res.on('close', () => {
            if (!res.writableEnded) controller.abort();
            this._inflight.delete(controller);
        });

        try {
            const ctx = await buildGatewayContext(resolved, this.keyStore, ref.model, controller.signal, catalogProvider, modelInfo);
            const upstream = await adapter.chat({ ...req.body, model: ref.model }, ctx);
            if (!(upstream instanceof Response)) {
                throw Object.assign(new Error('Adapter returned an invalid response'), { status: 502, type: 'gateway_error' });
            }
            res.status(upstream.status || 200);
            upstream.headers.forEach((value, key) => {
                if (key.toLowerCase() === 'content-length' || key.toLowerCase() === 'content-encoding') return;
                res.setHeader(key, value);
            });
            const usageTap = createUsageTap(
                (usage) => {
                    const tokens = tokensFromOpenAIUsage(usage);
                    if (!tokens || !this.stats) return;
                    this.stats.record({
                        provider: ref.provider,
                        model: ref.model,
                        price: modelInfo?.cost || null,
                        usage: tokens,
                        // SillyTavern sends the open chat id in this header.
                        chatId: String(req.get('x-omtp-chat') || '').replace(/^["']|["']$/g, '').trim().slice(0, 200),
                    });
                },
                { isStream: String(upstream.headers.get('content-type') || '').includes('text/event-stream') },
            );
            if (upstream.body) {
                pipeUpstream(upstream, res, controller, usageTap);
            } else {
                await sendUpstreamText(upstream, res, usageTap);
            }
        } catch (error) {
            if (controller.signal.aborted) return;
            const message = error instanceof Error ? error.message : 'Gateway error';
            if (!res.headersSent) {
                res.status(502).json(openAIErrorEnvelope(message, 'gateway_error', 'upstream_error'));
            } else {
                res.end();
            }
        }
    }
}

/**
 * Pass-through stream that feeds the usage tap.
 * @param {any} tap
 */
function createUsageTransform(tap) {
    return new Transform({
        transform(chunk, _encoding, done) {
            tap.push(chunk);
            done(null, chunk);
        },
        flush(done) {
            tap.end();
            done();
        },
    });
}

/**
 * Pipe a streaming upstream body to the client, feeding the usage tap and
 * aborting the upstream when the client goes away.
 * @param {Response} upstream
 * @param {import('express').Response} res
 * @param {AbortController} controller
 * @param {any} usageTap
 */
function pipeUpstream(upstream, res, controller, usageTap) {
    const nodeStream = Readable.fromWeb(/** @type {any} */ (upstream.body));
    nodeStream.on('error', (error) => {
        if (controller.signal.aborted) return;
        logError('gateway stream failed', error);
        if (!res.headersSent) {
            res.status(502).json(openAIErrorEnvelope(
                error instanceof Error ? error.message : 'Upstream stream failed',
                'gateway_error',
                'upstream_error',
            ));
        } else {
            res.destroy();
        }
    });
    res.on('close', () => {
        if (!nodeStream.destroyed) nodeStream.destroy();
    });
    nodeStream.pipe(createUsageTransform(usageTap)).pipe(res);
}

/**
 * Forward a non-streamed upstream body after feeding the usage tap.
 * @param {Response} upstream
 * @param {import('express').Response} res
 * @param {any} usageTap
 */
async function sendUpstreamText(upstream, res, usageTap) {
    const text = await upstream.text();
    usageTap.push(text);
    usageTap.end();
    res.end(text);
}

/**
 * Build the adapter ctx, resolving structured OAuth credentials (refreshing
 * when expired) the way OMP's AuthStorage does before a request.
 * @returns {Promise<any>}
 */
export async function buildGatewayContext(resolved, keyStore, model, signal, catalogProvider = null, modelInfo = null) {
    const { apiKey, credential } = await resolveAccessToken(resolved, keyStore);
    const ctx = buildProviderContext({ ...resolved, apiKey }, model, signal, catalogProvider, modelInfo);
    ctx.credential = credential;
    if (credential && resolved.id === 'anthropic') ctx.extraConfig.claudeCode = true;
    if (credential?.projectId && !ctx.extraConfig.project) ctx.extraConfig.project = credential.projectId;
    return ctx;
}
