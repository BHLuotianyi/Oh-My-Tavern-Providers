/**
 * Footer update indicator: compares the running build with what GitHub
 * publishes.
 *
 * The decision logic lives in `src/update-check.js`; this module only fetches,
 * caches the verdict in extension settings (10 minutes, GitHub's anonymous API
 * allows 60 requests per hour) and paints the bottom-left status line. A found
 * update or an unreleased `main` tip raises one notification per remote build,
 * so a long session is not nagged on every poll.
 */
import { EXTENSION_VERSION, EXTENSION_VERSION_CODE } from '../constants.js';
import {
    UPDATE_CACHE_MS,
    UPDATE_ENDPOINTS,
    compareUrl,
    evaluateUpdate,
    fetchRemoteInfo,
    isNightly,
} from '../update-check.js';
import { tr, trf } from './dom.js';
import { el, notify } from './helpers.js';
import { state } from './hub-state.js';
import { persist, settings } from './hub-utils.js';

/** @returns {{checkedAt:number, localVersion:string, remote:object, result:object}|null} */
function cachedCheck() {
    const cached = settings().updateCheck;
    if (!cached || typeof cached !== 'object' || typeof cached.checkedAt !== 'number') return null;
    if (cached.localVersion !== EXTENSION_VERSION) return null;
    if (!cached.remote || !cached.result) return null;
    return cached;
}

/**
 * Evaluate one check, reusing a recent cached verdict unless `force`.
 * @param {{force?: boolean}} [options]
 */
export async function checkForUpdates({ force = false } = {}) {
    const cached = cachedCheck();
    if (!force && cached && Date.now() - cached.checkedAt < UPDATE_CACHE_MS) {
        return { ...cached.result, remote: cached.remote, checkedAt: cached.checkedAt, cached: true };
    }
    if (state.updateInFlight) return state.updateInFlight;

    state.updateInFlight = (async () => {
        let remote = null;
        try {
            remote = await fetchRemoteInfo(EXTENSION_VERSION);
        } catch (error) {
            console.warn('[omtp] update check failed', error);
        }
        const result = evaluateUpdate({
            localVersion: EXTENSION_VERSION,
            localVersionCode: EXTENSION_VERSION_CODE,
            main: remote?.main,
            nightly: remote?.nightly,
            release: remote?.release,
        });
        const checkedAt = Date.now();
        persist({ updateCheck: { checkedAt, localVersion: EXTENSION_VERSION, remote, result } });
        return { ...result, remote, checkedAt, cached: false };
    })().finally(() => {
        state.updateInFlight = null;
    });

    return state.updateInFlight;
}

/** `2.0.0+nightly.20261103` -> `v2.0.0+nightly.20261103`. */
function versionLabel(version) {
    const text = String(version ?? '').trim().replace(/^v/i, '');
    return text ? `v${text}` : 'v—';
}

/**
 * Build the bottom-left status line: current version plus the update verdict.
 * The hub creates it once and `refreshUpdatePill` only repaints its parts.
 */
export function createUpdateStatus() {
    const status = el('button', 'omtp-update-status');
    status.id = 'omtp-update-status';
    status.type = 'button';
    status.title = tr('omtp_update_status', 'Update status');
    const dot = el('span', 'omtp-status-dot');
    dot.id = 'omtp-update-dot';
    const version = el('span', 'omtp-update-version', versionLabel(EXTENSION_VERSION));
    version.id = 'omtp-update-version';
    const label = el('span', 'omtp-status-label', tr('omtp_update_checking', 'Checking for updates…'));
    label.id = 'omtp-update-label';
    status.append(dot, version, el('span', 'omtp-update-sep', '·'), label);
    status.addEventListener('click', onUpdatePillClick);
    return status;
}

/** Short label for the remote side of a verdict. */
function remoteLabel(info) {
    if (info?.remoteVersion) return info.remoteVersion;
    if (info?.remoteRef) return String(info.remoteRef).slice(0, 7);
    return tr('omtp_update_unknown_short', 'unknown');
}

/** @param {string} status @param {string} label @param {string} title @param {string} dotClass */
function paint(status, label, title, dotClass) {
    const dot = document.getElementById('omtp-update-dot');
    const text = document.getElementById('omtp-update-label');
    const host = document.getElementById('omtp-update-status');
    if (!dot || !text || !host) return;
    dot.className = `omtp-status-dot ${dotClass}`;
    text.textContent = label;
    host.title = title || tr('omtp_update_status', 'Update status');
    host.dataset.status = status;
}

/** Where a click should land for the current verdict. */
function targetUrl(info) {
    if (isNightly(info?.localVersion)) return UPDATE_ENDPOINTS.nightlyCommits;
    if (info?.reason === 'release' && info.releaseTag) return UPDATE_ENDPOINTS.releasePage(info.releaseTag);
    // Every other verdict that compares against a release starts from its tag.
    if (info?.releaseTag) return compareUrl(info.releaseTag);
    if (info?.remoteRef && /^[0-9a-f]{7,40}$/i.test(info.remoteRef)) return compareUrl(info.remoteRef);
    return UPDATE_ENDPOINTS.commits;
}

/**
 * Re-check and repaint the footer status line.
 * @param {{force?: boolean}} [options]
 * @returns {Promise<object|null>}
 */
export async function refreshUpdatePill({ force = false } = {}) {
    if (!document.getElementById('omtp-update-status')) return null;
    paint('checking', tr('omtp_update_checking', 'Checking for updates…'), tr('omtp_update_status', 'Update status'), '');

    let info;
    try {
        info = await checkForUpdates({ force });
    } catch (error) {
        info = evaluateUpdate({
            localVersion: EXTENSION_VERSION,
            localVersionCode: EXTENSION_VERSION_CODE,
            main: null,
        });
        console.warn('[omtp] update check threw', error);
    }
    state.updateInfo = info;

    switch (info.status) {
        case 'update': {
            const label = trf('omtp_update_available', 'Update available (${0})', remoteLabel(info));
            paint('update', label, tr(
                'omtp_update_available_hint',
                'A newer release or build is published; click to open it on GitHub',
            ), 'omtp-dot-update');
            announce(info);
            break;
        }
        case 'pending': {
            const label = tr('omtp_update_pending', 'main has newer commits');
            paint('pending', label, trf(
                'omtp_update_pending_hint',
                'The running build is the newest release, but main has unreleased commits (latest ${0}); click to review or pull them',
                remoteLabel(info),
            ), 'omtp-dot-pending');
            announce(info);
            break;
        }
        case 'current':
            paint('current', tr('omtp_update_current', 'Up to date'), trf(
                'omtp_update_current_hint',
                'This build matches what GitHub publishes (${0})',
                remoteLabel(info),
            ), 'omtp-dot-current');
            break;
        case 'ahead':
            paint('ahead', tr('omtp_update_ahead', 'Local build is newer'), tr(
                'omtp_update_ahead_hint',
                'This nightly or pre-release build is ahead of main',
            ), 'omtp-dot-ahead');
            break;
        default:
            paint('unknown', tr('omtp_update_unknown', 'Update check failed'), tr(
                'omtp_update_unknown_hint',
                'GitHub is unreachable — click to retry',
            ), 'omtp-dot-muted');
            break;
    }
    return info;
}

/** One toast per remote build, for the states a user should act on. */
function announce(info) {
    const key = info.remoteRef || info.remoteVersion;
    if (!key || state.updateNotifiedFor === key) return;
    state.updateNotifiedFor = key;
    notify('info', info.status === 'pending'
        ? trf('omtp_update_pending_notify', 'main has commits since the last release (${0}); pull to update.', remoteLabel(info))
        : trf('omtp_update_notify', 'OMTP update available: ${0}. Click the update indicator in the footer to view it.', remoteLabel(info)));
}

/**
 * Status-line click: open GitHub for an actionable verdict, otherwise retry.
 */
export async function onUpdatePillClick() {
    const info = state.updateInfo;
    if (info && (info.status === 'update' || info.status === 'pending')) {
        window.open(targetUrl(info), '_blank', 'noopener');
        return;
    }
    await refreshUpdatePill({ force: true });
}
