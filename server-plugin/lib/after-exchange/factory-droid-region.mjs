/**
 * `factory-droid-region` post-exchange hook: resolve the Factory organization
 * and residency/inference scope.
 */
import {
    AfterExchangeError,
    compact,
    isRecord,
    requestSignal,
} from './shared.mjs';

const FACTORY_WHOAMI_TIMEOUT_MS = 15_000;

/** Factory API host per residency region; EU accounts are served from the EU region. */
function factoryDroidApiBaseUrl(region) {
    return region === 'eu' ? 'https://api.eu.factory.ai' : 'https://api.factory.ai';
}

/** Explicit inference scope wins, else EU residency infers EU, else global. */
function resolveFactoryDroidInferenceRegion(scope) {
    if (scope?.inferenceRegion) return scope.inferenceRegion;
    return scope?.region === 'eu' ? 'eu' : 'global';
}

/**
 * Resolve the canonical Factory identity: residency chooses the API host,
 * inference scope chooses eligible routes. Unlike most hooks this one can fail
 * the login — Factory rejects credentials without an organization.
 * @param {any} credential
 * @param {any} context
 */
export async function attachFactoryDroidRegion(credential, context) {
    if (context.signal?.aborted) throw new AfterExchangeError('Login cancelled');
    if (!isRecord(context.raw) || typeof context.raw.refresh_token !== 'string' || !credential.refresh) {
        throw new AfterExchangeError('Factory token response missing refresh token');
    }
    const login = context.phase !== 'refresh';
    const stored = context.stored || {};
    const selectedOrg = typeof context.raw.organization_id === 'string'
        ? context.raw.organization_id
        : stored.activeOrganizationId;
    // The token's Factory org claim belongs to the new bearer: a different
    // claim is an org change even when the WorkOS selection is unchanged.
    const factoryOrgChanged = Boolean(credential.orgId && stored.orgId && credential.orgId !== stored.orgId);
    const sameOrg = !factoryOrgChanged
        && (!selectedOrg || !stored.activeOrganizationId || selectedOrg === stored.activeOrganizationId);
    const identity = compact({
        ...credential,
        activeOrganizationId: selectedOrg,
        orgId: credential.orgId ?? (sameOrg ? stored.orgId : undefined),
        region: sameOrg ? stored.region : undefined,
        inferenceRegion: sameOrg ? stored.inferenceRegion : undefined,
    });
    const signal = requestSignal(context.signal, FACTORY_WHOAMI_TIMEOUT_MS);
    try {
        const response = await context.fetch(`${factoryDroidApiBaseUrl(identity.region)}/api/cli/whoami`, {
            headers: {
                Authorization: `Bearer ${credential.access}`,
                Accept: 'application/json',
                ...(identity.orgId ? { 'X-Factory-Org-Id': identity.orgId } : {}),
            },
            signal,
        });
        if (!response.ok && login) {
            throw new AfterExchangeError(`Factory identity check failed (${response.status}): ${await response.text()}`);
        }
        if (response.ok) {
            const body = await response.json();
            if (isRecord(body)) {
                const orgId = typeof body.orgId === 'string' && body.orgId ? body.orgId : identity.orgId;
                if (login && !orgId) {
                    throw new AfterExchangeError('Factory login did not resolve an organization');
                }
                // A different organization must not inherit the stored scope.
                const carried = !orgId || !identity.orgId || orgId === identity.orgId ? identity : undefined;
                const region = body.region === 'eu' || body.region === 'global' ? body.region : carried?.region;
                const inferenceRegion = body.inferenceRegion === 'global'
                    || body.inferenceRegion === 'eu'
                    || body.inferenceRegion === 'us'
                    ? body.inferenceRegion
                    : resolveFactoryDroidInferenceRegion({ region, inferenceRegion: carried?.inferenceRegion });
                return compact({ ...identity, orgId, region, inferenceRegion });
            }
        }
    } catch (error) {
        if (context.signal?.aborted) throw new AfterExchangeError('Login cancelled');
        if (login) throw error;
        // Refresh keeps the stored identity rather than failing the refresh.
    }
    if (context.signal?.aborted) throw new AfterExchangeError('Login cancelled');
    if (login && !identity.orgId) {
        throw new AfterExchangeError('Factory login did not resolve an organization');
    }
    return identity;
}
