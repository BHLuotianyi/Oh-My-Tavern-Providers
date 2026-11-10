/**
 * Claude Code billing attestation for subscription (OAuth) requests, a port of
 * OMP's `createClaudeBillingHeader` / `wrapFetchForCch`
 * (`packages/ai/src/providers/anthropic.ts`).
 *
 * Claude Code sends `system[0]` as
 *   `x-anthropic-billing-header: cc_version=<ver>.<fp>; cc_entrypoint=cli; cch=<hash>;`
 * followed by its identity block. Without it Anthropic answers OAuth requests
 * that carry any caller system prompt with 429 `rate_limit_error` "Error".
 *
 * - `fp`: first 3 hex of SHA-256(salt + chars 4, 7, 20 of the first user turn + version).
 * - `cch`: low 20 bits of XXH64(body with `cch=00000` in place, seed), 5 hex.
 */
import crypto from 'node:crypto';
import { claudeCodeVersion } from './client-versions.mjs';

export const BILLING_HEADER_PREFIX = 'x-anthropic-billing-header:';
const FINGERPRINT_SALT = '59cf53e54c78';
const CCH_PLACEHOLDER = 'cch=00000';
const CCH_SEED = 0x4d659218e32a3268n;
/** `system[0]` as JSON.stringify writes it; the placeholder must follow it closely. */
const BILLING_SYSTEM_MARKER = Buffer.from(`"system":[{"type":"text","text":"${BILLING_HEADER_PREFIX}`);
const CCH_SEARCH_WINDOW = 150;

/**
 * @param {string} firstUserText text of the first user turn on the wire
 * @param {Record<string, string|undefined>} [env]
 */
export function createBillingHeader(firstUserText, env = process.env) {
    const version = claudeCodeVersion(env);
    const picked = [4, 7, 20].map((i) => firstUserText[i] ?? '0').join('');
    const suffix = crypto.createHash('sha256').update(`${FINGERPRINT_SALT}${picked}${version}`).digest('hex').slice(0, 3);
    return `${BILLING_HEADER_PREFIX} cc_version=${version}.${suffix}; cc_entrypoint=cli; ${CCH_PLACEHOLDER};`;
}

const MASK = 0xffffffffffffffffn;
const P1 = 11400714785074694791n;
const P2 = 14029467366897019727n;
const P3 = 1609587929392839161n;
const P4 = 9650029242287828579n;
const P5 = 2870177450012600261n;
const rotl = (x, r) => ((x << BigInt(r)) | (x >> BigInt(64 - r))) & MASK;
const round = (acc, lane) => (rotl((acc + lane * P2) & MASK, 31) * P1) & MASK;
const merge = (acc, val) => ((((acc ^ round(0n, val)) * P1) & MASK) + P4) & MASK;

/**
 * XXH64 of a byte buffer.
 * @param {Uint8Array} input
 * @param {bigint} seed
 * @returns {bigint}
 */
export function xxh64(input, seed) {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const len = input.byteLength;
    let i = 0;
    let h;
    if (len >= 32) {
        let v1 = (seed + P1 + P2) & MASK;
        let v2 = (seed + P2) & MASK;
        let v3 = seed;
        let v4 = (seed - P1) & MASK;
        for (; i + 32 <= len; i += 32) {
            v1 = round(v1, view.getBigUint64(i, true));
            v2 = round(v2, view.getBigUint64(i + 8, true));
            v3 = round(v3, view.getBigUint64(i + 16, true));
            v4 = round(v4, view.getBigUint64(i + 24, true));
        }
        h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) & MASK;
        h = merge(h, v1);
        h = merge(h, v2);
        h = merge(h, v3);
        h = merge(h, v4);
    } else {
        h = (seed + P5) & MASK;
    }
    h = (h + BigInt(len)) & MASK;
    for (; i + 8 <= len; i += 8) {
        h ^= round(0n, view.getBigUint64(i, true));
        h = ((rotl(h, 27) * P1) & MASK) + P4 & MASK;
    }
    if (i + 4 <= len) {
        h ^= (BigInt(view.getUint32(i, true)) * P1) & MASK;
        h = ((rotl(h, 23) * P2) & MASK) + P3 & MASK;
        i += 4;
    }
    for (; i < len; i++) {
        h ^= (BigInt(input[i]) * P5) & MASK;
        h = (rotl(h, 11) * P1) & MASK;
    }
    h ^= h >> 33n;
    h = (h * P2) & MASK;
    h ^= h >> 29n;
    h = (h * P3) & MASK;
    h ^= h >> 32n;
    return h;
}

/**
 * Serialize a Messages payload and patch the `cch` attestation into the
 * billing block. Payloads without the billing block serialize unchanged.
 * @param {any} payload
 * @returns {string|Buffer}
 */
export function serializeWithAttestation(payload) {
    const text = JSON.stringify(payload);
    if (!text.includes(CCH_PLACEHOLDER)) return text;
    const body = Buffer.from(text);
    const marker = body.indexOf(BILLING_SYSTEM_MARKER);
    if (marker === -1) return text;
    const from = marker + BILLING_SYSTEM_MARKER.length;
    const at = body.indexOf(CCH_PLACEHOLDER, from);
    if (at === -1 || at - from > CCH_SEARCH_WINDOW) return text;
    const cch = (xxh64(body, CCH_SEED) & 0xfffffn).toString(16).padStart(5, '0');
    body.write(cch, at + 4, 'latin1');
    return body;
}
