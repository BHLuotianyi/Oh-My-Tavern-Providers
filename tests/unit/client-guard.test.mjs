import test from 'node:test';
import assert from 'node:assert/strict';
import { checkTrustedClient, CLIENT_HEADER, CLIENT_HEADER_VALUE } from '../../server-plugin/lib/client-guard.mjs';

/** @param {Record<string, string>} headers */
const request = (headers) => ({ headers });
const clientHeader = { [CLIENT_HEADER]: CLIENT_HEADER_VALUE };

test('a management request must carry the OMTP client header', () => {
    assert.deepEqual(checkTrustedClient(request({})), { ok: false, reason: 'missing_client_header' });
    assert.equal(checkTrustedClient(request({ [CLIENT_HEADER]: 'something-else' })).ok, false);
    assert.equal(checkTrustedClient(request(clientHeader)).ok, true);
});

test('a browser request from another origin is rejected', () => {
    const crossOrigin = {
        ...clientHeader,
        host: 'localhost:8000',
        origin: 'https://evil.example',
    };
    assert.equal(checkTrustedClient(request(crossOrigin)).reason, 'origin_mismatch');

    const sameOrigin = { ...crossOrigin, origin: 'http://localhost:8000' };
    assert.equal(checkTrustedClient(request(sameOrigin)).ok, true);

    const malformedOrigin = { ...crossOrigin, origin: 'not a url' };
    assert.equal(checkTrustedClient(request(malformedOrigin)).reason, 'invalid_origin');
});

test('fetch metadata blocks cross-site requests', () => {
    const crossSite = { ...clientHeader, 'sec-fetch-site': 'cross-site' };
    assert.equal(checkTrustedClient(request(crossSite)).reason, 'cross_site_request');

    const sameSite = { ...clientHeader, 'sec-fetch-site': 'same-site' };
    assert.equal(checkTrustedClient(request(sameSite)).ok, true);
});

test('strict host mode pins the Host header (DNS rebinding)', () => {
    const options = { strictHost: true, env: {}, allowedHosts: ['st.example.com'] };
    const rebound = { ...clientHeader, host: 'evil.example:8000' };
    assert.equal(checkTrustedClient(request(rebound), options).reason, 'host_not_allowed');

    const local = { ...clientHeader, host: '127.0.0.1:8000' };
    assert.equal(checkTrustedClient(request(local), options).ok, true);

    const allowed = { ...clientHeader, host: 'st.example.com' };
    assert.equal(checkTrustedClient(request(allowed), options).ok, true);
});
