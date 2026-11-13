/**
 * OMTP Model Hub — SillyTavern client extension entry point.
 *
 * The manifest maps the extension hooks to these exports (SillyTavern >= 1.17.0):
 *   activate -> init, disable -> disable, clean -> clean, delete -> onDelete.
 *
 * For SillyTavern < 1.17.0 (which loads extensions via script tag without manifest hooks),
 * an auto-bootstrap initializes the hub idempotently on DOM ready.
 *
 * All implementation lives in src/ui/hub.js so the entry point stays a thin,
 * dependency-free adapter that SillyTavern can load very early.
 */
import {
    init as hubInit,
    disable as hubDisable,
    clean as hubClean,
    onDelete as hubOnDelete,
} from './src/ui/hub.js';

let hostManaged = false;
let torndown = false;
let watcher = null;
let extensionsPromise = null;

function stopWatcher() {
    if (watcher !== null) {
        clearInterval(watcher);
        watcher = null;
    }
}

export async function init() {
    hostManaged = true;
    torndown = false;
    stopWatcher();
    return hubInit();
}

export async function disable() {
    stopWatcher();
    if (torndown) return;
    torndown = true;
    return hubDisable();
}

export async function clean() {
    stopWatcher();
    if (torndown) return;
    torndown = true;
    return hubClean();
}

export async function onDelete() {
    stopWatcher();
    if (torndown) return;
    torndown = true;
    return hubOnDelete();
}

// Auto-bootstrap fallback for ST < 1.17.0 where manifest.hooks is not supported.
// init() is strictly idempotent via internal `initialized` guard in src/ui/hub.js.
if (typeof window !== 'undefined' && typeof document === 'object') {
    // Old hosts never call the disable/clean hooks, so disabling the extension
    // there used to leave Custom OpenAI pointing at 127.0.0.1:4100. Poll the
    // host's disabled list and run the same teardown a modern host would.
    // Removing the files entirely still needs a manual restore (nothing is
    // loaded after the next reload) — documented in the README.
    const parts = new URL(import.meta.url).pathname.split('/');
    const thirdPartyIndex = parts.indexOf('third-party');
    const extensionId = thirdPartyIndex >= 0
        ? `third-party/${parts[thirdPartyIndex + 1]}`
        : 'third-party/omtp-model-hub';

    const startLegacyWatcher = async () => {
        if (hostManaged || torndown || watcher !== null) {
            return;
        }
        let extSettings;
        try {
            extensionsPromise ??= import('../../../extensions.js');
            ({ extension_settings: extSettings } = await extensionsPromise);
        } catch {
            return;
        }
        if (hostManaged || torndown || watcher !== null) {
            return;
        }
        watcher = setInterval(() => {
            const disabled = Array.isArray(extSettings?.disabledExtensions)
                && extSettings.disabledExtensions.includes(extensionId);
            if (!disabled) return;
            stopWatcher();
            if (torndown) return;
            torndown = true;
            hubDisable().catch((err) => console.warn('[omtp] legacy teardown failed', err));
        }, 3000);
    };

    const autoInit = () => {
        if (hostManaged) return;
        torndown = false;
        hubInit().catch((err) => console.warn('[omtp] auto-init failed', err));
        startLegacyWatcher().catch(() => {});
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoInit, { once: true });
    } else {
        setTimeout(autoInit, 0);
    }
}
