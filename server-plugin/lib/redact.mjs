/**
 * Log an error prefixed with the plugin scope.
 * @param {string} scope
 * @param {unknown} error
 */
export function logError(scope, error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[omtp] ${scope}: ${message}`);
}

/**
 * Log a plain informational message.
 * @param {string} message
 */
export function log(message) {
    console.log(`[omtp] ${message}`);
}
