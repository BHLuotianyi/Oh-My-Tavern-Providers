import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import miniExpress from '../../server-plugin/lib/mini-express.mjs';

/** Serve `app` on an ephemeral port for the duration of `run`. */
async function withApp(app, run) {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        await run(base);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

function buildApp() {
    const app = miniExpress();
    app.use(miniExpress.json({ limit: '1kb' }));
    const router = miniExpress.Router();
    router.use((req, res, next) => {
        if (req.get('x-deny')) {
            next(Object.assign(new Error('denied'), { status: 403 }));
            return;
        }
        next();
    });
    router.get('/providers/:id/login/:session', (req, res) => {
        res.json({ params: req.params, query: req.query, path: req.path });
    });
    router.post('/providers/:id/key', (req, res) => {
        res.status(201).json({ id: req.params.id, body: req.body });
    });
    router.get('/boom', () => {
        throw new Error('exploded');
    });
    router.use((req, res) => res.status(404).json({ error: 'router 404' }));
    // eslint-disable-next-line no-unused-vars
    router.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
    app.use('/api/plugins/omtp', router);
    return app;
}

test('mounted router matches params, decodes them and strips the mount path', async () => {
    await withApp(buildApp(), async (base) => {
        const response = await fetch(`${base}/api/plugins/omtp/providers/a%2Fb/login/s1?refresh=true`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
            params: { id: 'a/b', session: 's1' },
            query: { refresh: 'true' },
            path: '/providers/a%2Fb/login/s1',
        });
    });
});

test('JSON bodies are parsed and the method must match', async () => {
    await withApp(buildApp(), async (base) => {
        const response = await fetch(`${base}/api/plugins/omtp/providers/openai/key`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: 'sk' }),
        });
        assert.equal(response.status, 201);
        assert.deepEqual(await response.json(), { id: 'openai', body: { key: 'sk' } });

        const wrongMethod = await fetch(`${base}/api/plugins/omtp/providers/openai/key`);
        assert.deepEqual(await wrongMethod.json(), { error: 'router 404' });
    });
});

test('errors from middleware and thrown handlers reach the error handler', async () => {
    await withApp(buildApp(), async (base) => {
        const denied = await fetch(`${base}/api/plugins/omtp/boom`, { headers: { 'x-deny': '1' } });
        assert.equal(denied.status, 403);
        assert.deepEqual(await denied.json(), { error: 'denied' });

        const thrown = await fetch(`${base}/api/plugins/omtp/boom`);
        assert.equal(thrown.status, 500);
        assert.deepEqual(await thrown.json(), { error: 'exploded' });
    });
});

test('bodies over the limit are rejected and paths outside the mount get the app 404', async () => {
    await withApp(buildApp(), async (base) => {
        const tooLarge = await fetch(`${base}/api/plugins/omtp/providers/x/key`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: 'x'.repeat(2048) }),
        });
        assert.equal(tooLarge.status, 413);

        const outside = await fetch(`${base}/api/plugins/omtpx/providers/x/login/y`);
        assert.equal(outside.status, 404);
    });
});

test('malformed URLs like GET // and invalid percent-encoded params return 400 without crashing', async () => {
    await withApp(buildApp(), async (base) => {
        // Use raw HTTP so Node's fetch does not reject or normalize `//`.
        const rawStatus = await new Promise((resolve, reject) => {
            const req = http.request(`${base}/`, { method: 'GET', path: '//' }, (res) => {
                res.resume();
                res.on('end', () => resolve(res.statusCode));
            });
            req.on('error', reject);
            req.end();
        });
        assert.ok(rawStatus >= 400 && rawStatus < 500, `expected 4xx, got ${rawStatus}`);

        const badParam = await fetch(`${base}/api/plugins/omtp/providers/%ZZ/login/s1`);
        assert.equal(badParam.status, 400);

        // Server must still be alive and handle valid requests afterward.
        const alive = await fetch(`${base}/api/plugins/omtp/providers/openai/login/s1`);
        assert.equal(alive.status, 200);
    });
});
