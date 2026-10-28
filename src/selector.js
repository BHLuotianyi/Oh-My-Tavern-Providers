/**
 * Pure selector grammar and resolution.
 *
 * Deliberately free of SillyTavern / lib.js imports so it can be unit tested
 * in Node and reused by the hub UI. Fuzzy search is injected via `options.fuse`
 * (the UI passes a Fuse instance from /lib.js).
 */

import { MAX_SEARCH_RESULTS, REASONING_LEVELS } from './constants.js';

function lower(value) {
    return typeof value === 'string' ? value.toLowerCase() : '';
}

function refKey(ref) {
    if (typeof ref === 'string') {
        return ref;
    }
    if (!ref || typeof ref !== 'object') {
        return '';
    }
    if (typeof ref.key === 'string' && ref.key.length > 0) {
        return ref.key;
    }
    return `${ref.kind}/${ref.provider}/${ref.model}`;
}

function keySet(refs) {
    const set = new Set();
    if (!Array.isArray(refs)) {
        return set;
    }
    for (const ref of refs) {
        const key = refKey(ref);
        if (key) {
            set.add(key.toLowerCase());
        }
    }
    return set;
}

function providerLookup(providers) {
    const map = new Map();
    const add = (id) => {
        if (typeof id === 'string' && id.length > 0 && !map.has(id.toLowerCase())) {
            map.set(id.toLowerCase(), id);
        }
    };

    if (providers instanceof Set || Array.isArray(providers)) {
        for (const item of providers) {
            if (typeof item === 'string') {
                add(item);
            } else if (item && typeof item === 'object') {
                add(item.key || item.provider || item.id);
            }
        }
        return map;
    }

    if (providers && typeof providers === 'object') {
        for (const [key, value] of Object.entries(providers)) {
            add(key);
            if (value && typeof value === 'object') {
                add(value.key || value.provider || value.id);
            }
        }
    }

    return map;
}

function isExactSelector(text, options) {
    const needle = lower(text);
    if (!needle) {
        return false;
    }

    if (Array.isArray(options.entries)) {
        return options.entries.some((entry) => {
            if (!entry) {
                return false;
            }
            const model = lower(entry.model);
            if (!model) {
                return false;
            }
            return model === needle
                || lower(entry.key) === needle
                || `${lower(entry.provider)}/${model}` === needle;
        });
    }

    const exact = options.exactModelIds;
    if (exact) {
        const ids = exact instanceof Set
            ? [...exact]
            : Array.isArray(exact)
                ? exact
                : Object.keys(exact);
        return ids.some((id) => lower(id) === needle);
    }

    return false;
}

function splitLevel(text, options) {
    if (isExactSelector(text, options)) {
        return { base: text, level: null };
    }
    const index = text.lastIndexOf(':');
    if (index <= 0) {
        return { base: text, level: null };
    }
    const suffix = lower(text.slice(index + 1));
    if (!REASONING_LEVELS.includes(suffix)) {
        return { base: text, level: null };
    }
    return { base: text.slice(0, index), level: suffix };
}

/**
 * Lex the selector string.
 *
 * @param {string} input
 * @param {{providers?: string[]|Set<string>|object, entries?: object[], exactModelIds?: string[]|Set<string>|object, quickSlots?: object[]}} [options]
 * @returns {{raw: string, kind: 'empty'|'slot'|'alias'|'ref'|'query', slot?: number, alias?: 'favorites'|'recents', provider?: string, model?: string, level?: string|null}}
 */
export function parseSelector(input, options = {}) {
    const raw = typeof input === 'string' ? input.trim() : '';
    if (!raw) {
        return { raw, kind: 'empty' };
    }

    const { base, level } = splitLevel(raw, options);

    const slotMatch = /^@([1-9])$/.exec(base);
    if (slotMatch) {
        return { raw, kind: 'slot', slot: Number(slotMatch[1]) - 1, level };
    }

    const aliasMatch = /^@(fav|favorites|recent|recents)$/i.exec(base);
    if (aliasMatch) {
        const alias = lower(aliasMatch[1]);
        return {
            raw,
            kind: 'alias',
            alias: alias === 'fav' || alias === 'favorites' ? 'favorites' : 'recents',
            level,
        };
    }

    const providers = options.providers
        ?? (Array.isArray(options.entries) ? options.entries.map((entry) => entry?.provider) : undefined);
    const lookup = providerLookup(providers);

    const slash = base.indexOf('/');
    if (slash > 0) {
        const providerPart = base.slice(0, slash);
        const model = base.slice(slash + 1);
        const canonical = lookup.get(lower(providerPart));
        if (canonical && model.length > 0) {
            return { raw, kind: 'ref', provider: canonical, model, level };
        }
    }

    return { raw, kind: 'query', model: base, level };
}

function matchTier(entry, needle, favoriteKeys, recentKeys) {
    const provider = lower(entry.provider);
    const model = lower(entry.model);
    const full = provider && model ? `${provider}/${model}` : model;
    if (full === needle || lower(entry.key) === needle) {
        return 0;
    }
    if (model === needle) {
        return 1;
    }
    const key = lower(entry.key || refKey(entry));
    if (favoriteKeys.has(key)) {
        return 2;
    }
    if (recentKeys.has(key)) {
        return 3;
    }
    return 4;
}

/**
 * Rank entries for a search query.
 *
 * Exact `provider/model` wins, then exact model id, then favorites, then
 * recents, then fuzzy/substring matches. `options.fuse` may be a Fuse
 * instance; otherwise a simple case-insensitive substring scorer is used.
 */
export function rankEntries(entries, query, options = {}) {
    const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
    const raw = typeof query === 'string' ? query.trim() : '';
    const limit = Number.isInteger(options.limit) && options.limit > 0
        ? options.limit
        : MAX_SEARCH_RESULTS;
    const favoriteKeys = keySet(options.favorites);
    const recentKeys = keySet(options.recents);

    if (!raw) {
        return list
            .map((entry, index) => ({
                entry,
                index,
                tier: favoriteKeys.has(lower(entry.key)) ? 0 : recentKeys.has(lower(entry.key)) ? 1 : 2,
                score: 0,
            }))
            .sort(compareRanked)
            .slice(0, limit)
            .map((row) => row.entry);
    }

    const needle = lower(raw);
    const fuseScores = new Map();
    if (options.fuse && typeof options.fuse.search === 'function') {
        try {
            for (const result of options.fuse.search(raw)) {
                if (result && result.item) {
                    fuseScores.set(result.item, typeof result.score === 'number' ? result.score : 1);
                }
            }
        } catch {
            // A malformed Fuse instance must never break selection.
        }
    }

    const ranked = [];
    list.forEach((entry, index) => {
        const provider = lower(entry.provider);
        const model = lower(entry.model);
        const full = provider && model ? `${provider}/${model}` : model;
        const tier = matchTier(entry, needle, favoriteKeys, recentKeys);

        let score = Infinity;
        if (tier === 0) {
            score = 0;
        } else if (tier === 1) {
            score = 1;
        } else {
            const fields = [model, lower(entry.modelLabel), provider, lower(entry.providerLabel), full];
            for (const field of fields) {
                if (!field) {
                    continue;
                }
                const position = field.indexOf(needle);
                if (position >= 0) {
                    score = Math.min(score, 10 + position);
                }
            }
            if (fuseScores.has(entry)) {
                const fuseScore = 20 + fuseScores.get(entry);
                score = Math.min(score, fuseScore);
            }
        }

        if (score === Infinity) {
            return;
        }

        ranked.push({ entry, index, tier, score });
    });

    ranked.sort(compareRanked);
    return ranked.slice(0, limit).map((row) => row.entry);
}

function compareRanked(a, b) {
    if (a.tier !== b.tier) {
        return a.tier - b.tier;
    }
    if (a.score !== b.score) {
        return a.score - b.score;
    }
    return a.index - b.index;
}

/**
 * Resolve a selector string against the current entry list.
 *
 * @returns {{entry: object, level: string|undefined, warning: string|null}|{error: string}}
 */
export function resolveSelector(input, entries, options = {}) {
    const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
    const providers = options.providers ?? list.map((entry) => entry.provider);
    const parsed = parseSelector(input, { ...options, providers, entries: options.entries ?? list });

    if (parsed.kind === 'empty') {
        return { error: 'Enter a model selector' };
    }

    const byKey = new Map(list.map((entry) => [lower(entry.key), entry]));
    const findRef = (ref) => {
        const key = lower(refKey(ref));
        if (!key) {
            return null;
        }
        return byKey.get(key) ?? null;
    };

    if (parsed.kind === 'slot') {
        const slots = Array.isArray(options.quickSlots) ? options.quickSlots : [];
        const ref = slots[parsed.slot];
        if (!ref) {
            return { error: `Quick slot ${parsed.slot + 1} is empty` };
        }
        const entry = findRef(ref);
        if (!entry) {
            return { error: `Quick slot ${parsed.slot + 1} points to an unavailable model` };
        }
        return { entry, level: parsed.level ?? undefined, warning: null };
    }

    if (parsed.kind === 'alias') {
        const source = parsed.alias === 'favorites' ? options.favorites : options.recents;
        const refs = Array.isArray(source) ? source : [];
        for (const ref of refs) {
            const entry = findRef(ref);
            if (entry) {
                const label = parsed.alias === 'favorites' ? 'Favorites' : 'Recent models';
                return {
                    entry,
                    level: parsed.level ?? undefined,
                    warning: `${label} contains ${refs.length} entries; using ${entry.modelLabel || entry.model}`,
                };
            }
        }
        return {
            error: parsed.alias === 'favorites' ? 'No favorites available' : 'No recent models available',
        };
    }

    if (parsed.kind === 'ref') {
        const match = list.find((entry) => lower(entry.provider) === lower(parsed.provider)
            && lower(entry.model) === lower(parsed.model));
        if (!match) {
            return { error: `Unknown model: ${parsed.provider}/${parsed.model}` };
        }
        return { entry: match, level: parsed.level ?? undefined, warning: null };
    }

    const exact = list.find((entry) => lower(entry.key) === lower(parsed.raw))
        ?? list.find((entry) => lower(entry.model) === lower(parsed.model));
    if (exact) {
        return { entry: exact, level: parsed.level ?? undefined, warning: null };
    }

    const ranked = rankEntries(list, parsed.model, { ...options, limit: 25 });
    if (ranked.length === 0) {
        return { error: `Unknown model: ${parsed.raw}` };
    }

    const entry = ranked[0];
    const warning = ranked.length > 1
        ? `${ranked.length} matches; selected ${entry.providerLabel ? `${entry.providerLabel} / ` : ''}${entry.modelLabel || entry.model}`
        : null;
    return { entry, level: parsed.level ?? undefined, warning };
}
