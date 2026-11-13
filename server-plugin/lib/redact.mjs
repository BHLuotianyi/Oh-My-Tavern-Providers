/**
 * Mask credentials and token-like strings before writing to logs.
 * @param {unknown} text
 * @returns {string}
 */
export function redactSecrets(text) {
    return String(text ?? '')
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [REDACTED]')
        .replace(/([?&](?:api_?key|key|token|access_token|refresh_token|client_secret|secret|password)=)[^&\s"'<>]+/gi, '$1[REDACTED]')
        .replace(/("(?:api_?key|access_token|refresh_token|client_secret|secret|authorization|x-api-key)"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
        .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{16,}|ya29\.[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, '[REDACTED]')
        .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?\b/g, '[REDACTED]')
        .replace(/(?<![A-Za-z0-9/_.-])(?=[A-Za-z0-9+/=]*[0-9])(?=[A-Za-z0-9+/=]*[A-Za-z])[A-Za-z0-9+/=]{32,}(?![A-Za-z0-9/_.-])/g, '[REDACTED]');
}

/**
 * Log an error prefixed with the plugin scope.
 * @param {string} scope
 * @param {unknown} error
 */
export function logError(scope, error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[omtp] ${scope}: ${redactSecrets(message)}`);
}

/**
 * Log a plain informational message.
 * @param {string} message
 */
export function log(message) {
    console.log(`[omtp] ${message}`);
}
