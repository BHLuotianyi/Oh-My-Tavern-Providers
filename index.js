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
import { init, disable, clean, onDelete } from './src/ui/hub.js';

export { init, disable, clean, onDelete };

// Auto-bootstrap fallback for ST < 1.17.0 where manifest.hooks is not supported.
// init() is strictly idempotent via internal `initialized` guard in src/ui/hub.js.
if (typeof window !== 'undefined' && typeof document === 'object') {
    const autoInit = () => {
        init().catch((err) => console.warn('[omtp] auto-init failed', err));
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoInit, { once: true });
    } else {
        setTimeout(autoInit, 0);
    }

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
    const watcher = setInterval(async () => {
        let disabled = false;
        try {
            const { extension_settings } = await import('../../../extensions.js');
            disabled = Array.isArray(extension_settings?.disabledExtensions)
                && extension_settings.disabledExtensions.includes(extensionId);
        } catch {
            return;
        }
        if (!disabled) return;
        clearInterval(watcher);
        disable().catch((err) => console.warn('[omtp] legacy teardown failed', err));
    }, 3000);
    watcher.unref?.();
}
