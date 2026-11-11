/**
 * The subset of Express the plugin core and the gateway use, for the
 * standalone companion: SillyTavern provides Express to server plugins, a
 * plain `node standalone.mjs` has no dependencies installed.
 *
 * Supported: `app()`/`Router()` with `use([path,] fn)`, `get`/`post`/`delete`,
 * `:param` segments, error middleware (four arguments), `json({ limit })`,
 * `req.params|query|body|path|get()`, `res.status()|json()`.
 */

const METHODS = ['get', 'post', 'delete'];

/**
 * @param {string} pattern route path such as `/providers/:id/key`
 * @returns {{regex: RegExp, keys: string[]}}
 */
function compileRoute(pattern) {
    const keys = [];
    const source = pattern
        .split('/')
        .map((segment) => {
            if (segment.startsWith(':')) {
                keys.push(segment.slice(1));
                return '([^/]+)';
            }
            return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/');
    return { regex: new RegExp(`^${source}/?$`), keys };
}

/**
 * @param {string} path
 * @param {string} prefix
 */
function underPrefix(path, prefix) {
    return prefix === '/' || path === prefix || path.startsWith(`${prefix}/`);
}

/** Decorate Node's request/response with the Express helpers the routes call. */
function decorate(req, res) {
    if (req.query) return;
    const url = new URL(req.url, 'http://localhost');
    req.path = url.pathname;
    req.query = Object.fromEntries(url.searchParams);
    req.params = {};
    req.get = (name) => req.headers[String(name).toLowerCase()];
    res.status = (code) => {
        res.statusCode = code;
        return res;
    };
    res.json = (value) => {
        if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(value));
        return res;
    };
}

function createRouter() {
    /** @type {Array<{method: string|null, prefix: string|null, route: ReturnType<typeof compileRoute>|null, fn: Function}>} */
    const layers = [];

    /**
     * Run the layers for `req`, then hand over to `done` (the parent's `next`).
     * @param {any} req
     * @param {any} res
     * @param {(error?: unknown) => void} done
     */
    function handle(req, res, done) {
        decorate(req, res);
        const method = String(req.method || 'GET').toLowerCase();
        const fullPath = req.path;
        let index = 0;

        const next = (error) => {
            req.path = fullPath;
            while (index < layers.length) {
                const layer = layers[index++];
                if (layer.method && layer.method !== method) continue;
                if (layer.prefix && !underPrefix(fullPath, layer.prefix)) continue;
                let match = null;
                if (layer.route) {
                    match = layer.route.regex.exec(fullPath);
                    if (!match) continue;
                }
                const isErrorHandler = layer.fn.length === 4;
                if (Boolean(error) !== isErrorHandler) continue;
                if (match) {
                    req.params = Object.fromEntries(layer.route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
                }
                if (layer.prefix && layer.prefix !== '/') {
                    req.path = fullPath.slice(layer.prefix.length) || '/';
                }
                try {
                    if (error) layer.fn(error, req, res, next);
                    else layer.fn(req, res, next);
                } catch (thrown) {
                    next(thrown);
                }
                return;
            }
            done(error);
        };
        next();
    }

    /** @type {any} */
    const router = (req, res, next) => handle(req, res, next);
    router.handle = handle;
    router.use = (...args) => {
        const prefix = typeof args[0] === 'string' ? args.shift() : null;
        for (const fn of args) {
            const inner = typeof fn.handle === 'function'
                ? (req, res, next) => fn.handle(req, res, next)
                : fn;
            // Keep the arity: it is how error middleware is recognised.
            layers.push({ method: null, prefix, route: null, fn: fn.length === 4 ? fn : inner });
        }
        return router;
    };
    for (const method of METHODS) {
        router[method] = (path, ...handlers) => {
            const route = compileRoute(path);
            for (const fn of handlers) layers.push({ method, prefix: null, route, fn });
            return router;
        };
    }
    router.disable = () => router;
    return router;
}

/**
 * Application: a router that answers 404 / 500 itself when nothing handles the request.
 * @returns {any}
 */
export default function miniExpress() {
    const router = createRouter();
    const app = (req, res) => router.handle(req, res, (error) => {
        if (res.headersSent) {
            res.end();
            return;
        }
        res.statusCode = error ? Number(error?.status) || 500 : 404;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: { message: error ? 'Server error' : 'Not found' } }));
    });
    Object.assign(app, router);
    app.handle = router.handle;
    return app;
}

miniExpress.Router = createRouter;

/**
 * JSON body parser. Bodies of other types leave `req.body` as `{}`.
 * @param {{limit?: string|number}} [options]
 */
miniExpress.json = ({ limit = '1mb' } = {}) => {
    const maxBytes = typeof limit === 'number' ? limit : parseSize(limit);
    return (req, res, next) => {
        if (req.body !== undefined) {
            next();
            return;
        }
        req.body = {};
        const type = String(req.headers['content-type'] || '');
        if (!/\bjson\b/i.test(type)) {
            next();
            return;
        }
        const chunks = [];
        let size = 0;
        let failed = false;
        req.on('data', (chunk) => {
            if (failed) return;
            size += chunk.length;
            if (size > maxBytes) {
                failed = true;
                next(Object.assign(new Error('Request body too large'), { status: 413 }));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (failed) return;
            const text = Buffer.concat(chunks).toString('utf8');
            if (!text.trim()) {
                next();
                return;
            }
            try {
                req.body = JSON.parse(text);
                next();
            } catch {
                next(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
            }
        });
        req.on('error', (error) => {
            if (!failed) next(error);
            failed = true;
        });
    };
};

/** @param {string} value such as `50mb` */
function parseSize(value) {
    const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(String(value).trim());
    if (!match) return 1024 * 1024;
    const unit = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(match[2] || 'b').toLowerCase()];
    return Math.floor(Number(match[1]) * unit);
}
