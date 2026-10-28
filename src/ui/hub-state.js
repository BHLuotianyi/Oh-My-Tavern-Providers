/**
 * Mutable state shared by the hub modules.
 *
 * Every module reads and writes `state.<field>`; nothing keeps a private copy,
 * so a re-render anywhere always sees the same hub.
 */
export const state = {
    /** @type {Array<object>} */
    entries: [],
    /** @type {Map<string, object>} */
    providerGroups: new Map(),
    /** @type {object|null} Fuse index over the visible entries. */
    fuse: null,
    initialized: false,
    isCleaningUp: false,
    isOpen: false,
    /** @type {HTMLElement|null} */
    modal: null,
    /** @type {Element|null} */
    previousFocus: null,
    currentTab: 'all',
    /** @type {string|null} */
    selectedProvider: null,
    /** @type {string|null} */
    selectedEntryKey: null,
    searchQuery: '',
    /** @type {ReturnType<typeof setTimeout>|null} */
    searchTimer: null,
    /** @type {Array<object>} */
    rowEntries: [],
    /** @type {Promise<object[]>|null} */
    catalogLoading: null,
    catalogLoaded: false,
    /**
     * Gateway provider status keyed by provider id.
     * @type {Map<string, {available:boolean, label:string, unsupportedReason:string|null}>}
     */
    providerAvailability: new Map(),
    /** @type {object|null} Model waiting to be dropped into a quick slot. */
    pendingQuickEntry: null,
    /** @type {string|null} Entry key to flash after a jump. */
    highlightKey: null,
    /** @type {ReturnType<typeof setTimeout>|null} */
    highlightTimer: null,
    /** @type {ReturnType<typeof setInterval>|null} */
    gatewayPollTimer: null,
};
