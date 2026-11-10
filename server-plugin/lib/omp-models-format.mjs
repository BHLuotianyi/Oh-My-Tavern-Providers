/**
 * Decoder for OMP's compact `models.json` (version 1), a port of
 * `packages/catalog/src/model-catalog-format.ts`.
 *
 * Layout: `keys` interns property names; `nodes` holds shared values as
 * `[0, [keyId, value, …], booleanShapeId, bitWords]` objects or `[1, values]`
 * arrays; a one-element array `[n]` references node `n` (`[-1]` is an explicit
 * undefined). Each provider row is `[id, constants, [[modelId, row, delta?]]]`,
 * and a model's `compat` is the per-API base in `compat` with `delta` applied
 * (`[removedKeyIds, changes]`).
 *
 * OMP releases before the compact format shipped a plain
 * `{provider: {modelId: model}}` object; that shape passes through unchanged so
 * older local OMP installs still import.
 */

/** @param {any} value */
export function isCompactOmpModels(value) {
    return Boolean(value) && value.version === 1 && Array.isArray(value.nodes) && Array.isArray(value.providers);
}

/**
 * @param {Record<string, unknown>} object
 * @param {string} key
 * @param {unknown} value
 */
function setProperty(object, key, value) {
    if (key === '__proto__') {
        Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
    } else {
        object[key] = value;
    }
}

/**
 * Materialize the compact catalog as `{provider: {modelId: model}}`.
 * @param {any} data
 * @returns {Record<string, Record<string, any>>}
 */
export function decodeOmpModels(data) {
    if (!isCompactOmpModels(data)) return data;
    const { keys, booleanShapes, nodes } = data;
    /** @type {Map<number, unknown>} */
    const values = new Map();
    const compatBases = new Map(data.compat || []);

    /**
     * @param {Record<string, unknown>} object
     * @param {any} node
     */
    const decodeObject = (object, node) => {
        for (let i = 0; i < node[1].length; i += 2) {
            setProperty(object, keys[node[1][i]], decode(node[1][i + 1]));
        }
        const shape = booleanShapes[node[2]];
        for (let i = 0; i < shape.length; i++) {
            setProperty(object, keys[shape[i]], ((node[3][i >>> 5] >>> (i % 32)) & 1) !== 0);
        }
    };

    /** @param {any} value */
    const decode = (value) => {
        if (!Array.isArray(value)) return value;
        const id = value[0];
        if (id === -1) return undefined;
        if (values.has(id)) return values.get(id);
        const node = nodes[id];
        if (!node) throw new Error(`OMP models.json references missing node ${id}`);
        let result;
        if (node[0] === 1) {
            result = node[1].map(decode);
        } else {
            result = {};
            decodeObject(result, node);
        }
        values.set(id, result);
        return result;
    };

    /** @type {Record<string, Record<string, any>>} */
    const providers = {};
    for (const [providerId, constantsRef, rows] of data.providers) {
        const constants = /** @type {Record<string, unknown>} */ (decode(constantsRef));
        /** @type {Record<string, any>} */
        const models = {};
        for (const [modelId, encoded, delta] of rows) {
            const row = Array.isArray(encoded) && encoded[0] >= 0 ? nodes[encoded[0]] : null;
            if (!row || row[0] !== 0) throw new Error(`OMP models.json has an invalid row for ${providerId}/${modelId}`);
            /** @type {Record<string, any>} */
            const model = { id: modelId, ...constants };
            decodeObject(model, row);
            if (delta) {
                const compat = { ...(/** @type {object} */ (decode(compatBases.get(model.api))) || {}) };
                for (const key of delta[0]) delete compat[keys[key]];
                const changes = /** @type {Record<string, unknown>} */ (decode(delta[1])) || {};
                for (const key of Object.keys(changes)) setProperty(compat, key, changes[key]);
                model.compat = compat;
            }
            setProperty(models, modelId, model);
        }
        setProperty(providers, providerId, models);
    }
    return providers;
}
