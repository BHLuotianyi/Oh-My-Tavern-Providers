/**
 * Reasoning-effort vocabulary shared by the hub and the slash commands.
 *
 * Catalog providers spell the same levels differently (`minimal` vs `min`,
 * `xhigh` vs `max`); SillyTavern only understands the values in
 * `REASONING_LEVELS`, so everything funnels through here.
 */
import { REASONING_LEVELS } from './constants.js';

/** Catalog spellings mapped onto SillyTavern's reasoning values. */
export const EFFORT_ALIASES = new Map([
    ['minimal', 'min'],
    ['minimum', 'min'],
    ['med', 'medium'],
    ['xhigh', 'max'],
    ['maximum', 'max'],
    ['none', 'auto'],
    ['off', 'auto'],
]);

/**
 * Map one effort name onto a SillyTavern level, or null when unsupported.
 * @param {unknown} effort
 * @returns {string|null}
 */
function normalizeEffort(effort) {
    const raw = String(effort ?? '').trim().toLowerCase();
    if (!raw) {
        return null;
    }
    const mapped = EFFORT_ALIASES.get(raw) ?? raw;
    return REASONING_LEVELS.includes(mapped) ? mapped : null;
}

/**
 * Deduplicated, ordered levels for a model.
 * @param {unknown[]} efforts catalog `efforts` array
 * @returns {string[]}
 */
export function normalizeEffortList(efforts) {
    const mapped = new Set(
        (Array.isArray(efforts) ? efforts : [])
            .map(normalizeEffort)
            .filter(Boolean),
    );
    if (!mapped.size) {
        return [...REASONING_LEVELS];
    }
    // `auto` is always selectable: it means "let the provider decide".
    return REASONING_LEVELS.filter((level) => level === 'auto' || mapped.has(level));
}
