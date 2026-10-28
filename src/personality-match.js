/**
 * Name matching for AA-PersonalityBench records.
 *
 * Kept free of UI imports so it can be unit-tested in Node. AA keys models by
 * slug (`gemini-4-argon`); our catalog ids look like `google-antigravity/gemini-4.1-argon`
 * or `meta/muse-wonder-1.0`, so both sides are normalised to a comparable form.
 */

/**
 * Lower-case, punctuation-free form.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeName(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * The model part of an entry id (`vendor/model` → `model`).
 * @param {unknown} model
 * @returns {string}
 */
export function modelSegment(model) {
    const parts = String(model ?? '').split('/');
    return parts[parts.length - 1];
}

/**
 * Pick the personality key that matches a catalog model, or null.
 *
 * Candidates are checked in order: the model segment, then the display label.
 * A version suffix is tolerated (`muse-wonder-1-0` → `muse-wonder`) but only
 * when the remainder is purely numeric, so `grok-4-7` never matches `grok-4`.
 *
 * @param {{model?: string, modelLabel?: string}|null} entry
 * @param {Iterable<string>} keys Known record keys.
 * @returns {string|null}
 */
export function matchPersonalityKey(entry, keys) {
    if (!entry) {
        return null;
    }
    const known = keys instanceof Set ? keys : new Set(keys);
    const candidates = [
        normalizeName(modelSegment(entry.model)),
        normalizeName(entry.modelLabel),
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (known.has(candidate)) {
            return candidate;
        }
    }
    for (const candidate of candidates) {
        for (const key of known) {
            if (!key) continue;
            if (candidate.startsWith(`${key}-`) && /^[0-9]+(-[0-9]+)*$/.test(candidate.slice(key.length + 1))) {
                return key;
            }
        }
    }
    return null;
}
