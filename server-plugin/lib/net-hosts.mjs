import net from 'node:net';

/**
 * Normalize a hostname by trimming whitespace, lowercasing, and stripping
 * any surrounding IPv6 brackets.
 * @param {unknown} hostname
 * @returns {string}
 */
function normalizeHost(hostname) {
    return String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
}

/**
 * Whether `hostname` is a loopback literal or `localhost`.
 * True for `localhost`, `::1` / `[::1]`, `0.0.0.0`, and IPv4 literals in `127.0.0.0/8`.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isLoopbackHost(hostname) {
    const host = normalizeHost(hostname);
    if (!host) return false;
    if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true;
    if (net.isIPv4(host)) {
        const firstOctet = Number(host.split('.')[0]);
        return firstOctet === 127;
    }
    return false;
}

/**
 * Whether `hostname` is a loopback or private/link-local IP literal.
 * Covers loopback + IPv4 10/8, 172.16/12, 192.168/16, 169.254/16 + IPv6 fc00::/7, fe80::/10.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isPrivateHost(hostname) {
    const host = normalizeHost(hostname);
    if (!host) return false;
    if (isLoopbackHost(host)) return true;
    if (net.isIPv4(host)) {
        const [a, b] = host.split('.').map(Number);
        if (a === 10) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 169 && b === 254) return true;
        return false;
    }
    const zoneIndex = host.indexOf('%');
    const ip6 = zoneIndex === -1 ? host : host.slice(0, zoneIndex);
    if (net.isIPv6(ip6)) {
        if (ip6.startsWith('::')) return false;
        const firstWord = Number.parseInt(ip6.split(':')[0], 16);
        if ((firstWord & 0xfe00) === 0xfc00) return true;
        if ((firstWord & 0xffc0) === 0xfe80) return true;
    }
    return false;
}

/**
 * Parse a raw HTTP `Host` header (with optional port or IPv6 brackets) and
 * check whether it refers to a loopback host.
 *
 * @param {string} hostHeader
 * @returns {boolean}
 */
export function isLoopbackHostHeader(hostHeader) {
    if (typeof hostHeader !== 'string') return false;
    const trimmed = hostHeader.trim();
    if (!trimmed || /[\s/@?#\\]/.test(trimmed)) return false;
    try {
        const parsed = new URL(`http://${trimmed}`);
        return isLoopbackHost(parsed.hostname);
    } catch {
        return false;
    }
}
