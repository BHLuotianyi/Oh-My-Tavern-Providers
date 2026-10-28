/**
 * Chat-header token chip.
 *
 * Shows this chat's token totals and estimated cost next to the OMTP button in
 * the API drawer toolbar, and opens the usage page on click. Numbers come from
 * the gateway's counters (`/stats?since=`), so they cover streaming and
 * non-streaming replies alike.
 */
import { getRequestHeaders } from '../../../../../../script.js';
import { API_BASE } from '../constants.js';
import { currentChatId, ensureUsageSession } from '../usage-session.js';
import { tr, trf } from './dom.js';
import { formatTokens, formatUsd } from './helpers.js';

const CHIP_ID = 'omtp-usage-chip';
const REFRESH_DEBOUNCE_MS = 600;

let chip = null;
let timer = null;

/**
 * Fetch the current chat's totals and repaint the chip.
 * @param {{force?: boolean}} [options]
 */
export async function refreshUsageChip({ force = false, chatId } = {}) {
    if (!chip) {
        return;
    }
    if (force) {
        ensureUsageSession({ force: true, chatId });
    }
    const since = ensureUsageSession({ chatId });
    const activeChat = typeof chatId === 'string' ? chatId : currentChatId();
    const query = activeChat ? `chat=${encodeURIComponent(activeChat)}` : `since=${encodeURIComponent(since)}`;
    try {
        const response = await fetch(`${API_BASE}/stats?${query}`, {
            headers: getRequestHeaders(),
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        const totals = data?.totals || {};
        const requests = Number(totals.requests) || 0;
        if (!requests) {
            chip.hidden = true;
            chip.textContent = '';
            return;
        }
        chip.hidden = false;
        const tokens = (Number(totals.input) || 0) + (Number(totals.cachedInput) || 0) + (Number(totals.output) || 0);
        chip.textContent = `${trf('omtp_chip_tokens', '${0} tok', formatTokens(tokens))} · ${formatUsd(totals.costUsd)}`;
        chip.title = [
            trf('omtp_chip_requests', '${0} requests this chat', requests),
            trf('omtp_chip_input', 'input ${0}', formatTokens(totals.input)),
            trf('omtp_chip_cached', 'cached ${0}', formatTokens(totals.cachedInput)),
            trf('omtp_chip_output', 'output ${0}', formatTokens(totals.output)),
            ...(totals.reasoning ? [trf('omtp_chip_reasoning', 'reasoning ${0}', formatTokens(totals.reasoning))] : []),
            trf('omtp_chip_cost', 'estimated ${0}', formatUsd(totals.costUsd)),
            tr('omtp_chip_open', 'Click to open the usage page'),
        ].join('\n');
    } catch {
        // The gateway may be down; keep the last numbers instead of flickering.
    }
}

/** Debounced refresh, safe to call from event handlers. */
export function scheduleUsageChipRefresh() {
    clearTimeout(timer);
    timer = setTimeout(() => {
        timer = null;
        refreshUsageChip().catch(() => {});
    }, REFRESH_DEBOUNCE_MS);
}

/**
 * Mount the chip next to the OMTP toolbar button.
 * @param {{onOpen?: Function}} [options]
 * @returns {HTMLElement|null}
 */
export function mountUsageChip({ onOpen } = {}) {
    // The top bar stays visible while chatting, unlike the API drawer block.
    const holder = document.getElementById('top-settings-holder');
    if (!holder) {
        return null;
    }
    document.getElementById(CHIP_ID)?.remove();
    chip = document.createElement('button');
    chip.type = 'button';
    chip.id = CHIP_ID;
    chip.className = 'omtp-usage-chip';
    chip.hidden = true;
    chip.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpen?.({ tab: 'usage' });
    });
    holder.append(chip);
    refreshUsageChip().catch(() => {});
    return chip;
}

/** Remove the chip and stop pending timers. */
export function disposeUsageChip() {
    clearTimeout(timer);
    timer = null;
    chip?.remove();
    chip = null;
}
