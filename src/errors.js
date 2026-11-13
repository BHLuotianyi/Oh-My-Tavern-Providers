/**
 * Coded errors for user-facing failures.
 *
 * The switch engine runs inside SillyTavern but must not import UI helpers, so
 * it throws errors that carry a stable `code` plus `params`. The UI layer turns
 * those into translated text with `describeError` (`ui/dom.js`); anything
 * without a code keeps its own message, which is already user-facing.
 */

/**
 * @param {string} code stable identifier, see `ERROR_TEXT` in ui/dom.js
 * @param {Array<string|number>} [params] values for `${0}`, `${1}`, …
 * @param {string} [message] English fallback shown when the code is unknown
 * @returns {Error}
 */
export function codedError(code, params = [], message = '') {
  const error = new Error(message || code);
  /** @type {any} */ (error).code = code;
  /** @type {any} */ (error).params = Array.isArray(params) ? params.map(String) : [];
  return error;
}
