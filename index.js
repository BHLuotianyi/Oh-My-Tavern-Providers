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
        try {
            init().catch((err) => console.warn('[omtp] auto-init failed', err));
        } catch (err) {
            console.warn('[omtp] auto-init failed', err);
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoInit, { once: true });
    } else {
        setTimeout(autoInit, 0);
    }
}
