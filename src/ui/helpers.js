/**
 * Shared UI helper utilities for OMTP Model Hub.
 */

/**
 * Create an element with optional class and text.
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
export function el(tag, className, text) {
    const element = document.createElement(tag);
    if (className) {
        element.className = className;
    }
    if (text !== undefined && text !== null) {
        element.textContent = String(text);
    }
    return element;
}

/**
 * Check whether value is a non-null, non-array plain object.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Show a toastr notification when available, falling back to console.
 * @param {'info'|'success'|'warning'|'error'} kind
 * @param {string} message
 */
export function notify(kind, message) {
    const fn = globalThis.toastr?.[kind];
    if (typeof fn === 'function') {
        fn(message);
    } else if (kind === 'error') {
        console.error('[omtp]', message);
    } else {
        console.log('[omtp]', message);
    }
}

/** @param {number} value */
export function formatTokens(value) {
    const tokens = Number(value) || 0;
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
    return String(Math.round(tokens));
}

/** @param {number} value */
export function formatUsd(value) {
    const usd = Number(value) || 0;
    if (!usd) return '$0';
    if (usd < 0.001) return `$${usd.toFixed(6)}`;
    if (usd < 0.01) return `$${usd.toFixed(4)}`;
    if (usd < 1) return `$${usd.toFixed(3)}`;
    return `$${usd.toFixed(2)}`;
}
