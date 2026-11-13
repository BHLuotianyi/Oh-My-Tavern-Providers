/**
 * Standalone HTML page & localization for the loopback OAuth callback.
 *
 * The browser opens the callback page directly, so the locale comes from the
 * client that started the session (falling back to `Accept-Language`), never
 * from the server's own settings.
 */

const CALLBACK_TEXT = {
    en: {
        title: 'OMTP sign-in',
        done: 'Login complete. You can close this tab and return to SillyTavern.',
        failed: 'Login failed. You can close this tab and start again from SillyTavern.',
        missing: 'The provider did not return an authorization code.',
        mismatch: 'This callback does not belong to the current sign-in; SillyTavern is still waiting for it.',
        manual: 'If SillyTavern did not switch to signed in by itself, copy the address below, paste it into the input box in SillyTavern and click Submit.',
        copy: 'Copy',
        copied: 'Copied',
    },
    'zh-cn': {
        title: 'OMTP 登录',
        done: '登录成功，可以关闭此页面并返回 SillyTavern。',
        failed: '登录失败，可以关闭此页面并在 SillyTavern 中重试。',
        missing: '服务商没有返回授权码。',
        mismatch: '此回调不属于当前登录请求，SillyTavern 仍在等待登录完成。',
        manual: '如果此时酒馆页面没有自动成功，请复制以下内容到输入框并点击提交。',
        copy: '复制',
        copied: '已复制',
    },
};

/**
 * Pick the closest supported locale.
 * @param {string|undefined} requested
 * @param {string|undefined} acceptLanguage
 * @returns {'en'|'zh-cn'}
 */
export function pickLocale(requested, acceptLanguage) {
    const candidates = [];
    if (requested) candidates.push(String(requested).toLowerCase());
    for (const part of String(acceptLanguage || '').toLowerCase().split(',')) {
        const tag = part.split(';')[0].trim();
        if (tag) candidates.push(tag);
    }
    for (const tag of candidates) {
        if (tag.startsWith('zh')) return 'zh-cn';
        if (tag.startsWith('en')) return 'en';
    }
    return 'en';
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Minimal standalone page for the callback.
 * @param {'done'|'failed'|'missing'|'mismatch'} outcome
 * @param {string} locale
 * @param {string} [requestUrl] full callback URL, for the manual paste fallback
 * @returns {string}
 */
export function callbackPage(outcome, locale, requestUrl = '') {
    const text = CALLBACK_TEXT[locale] || CALLBACK_TEXT.en;
    const message = text[outcome];
    const accent = outcome === 'done' ? '#3ba55d' : '#e05252';
    const manual = requestUrl ? `
<p class="hint">${text.manual}</p>
<input id="cb-url" readonly value="${escapeHtml(requestUrl)}" spellcheck="false">
<button id="cb-copy" type="button">${text.copy}</button>
<script>
document.getElementById('cb-copy').addEventListener('click', async () => {
    const field = document.getElementById('cb-url');
    field.select();
    try { await navigator.clipboard.writeText(field.value); } catch { document.execCommand('copy'); }
    const button = document.getElementById('cb-copy');
    button.textContent = ${JSON.stringify(text.copied)};
});
</script>` : '';
    return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${text.title}</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#15141b;color:#e6e6ef;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.card{max-width:26rem;padding:2rem 2.25rem;border:1px solid #2c2b38;border-radius:14px;background:#1c1b24;box-shadow:0 12px 32px rgba(0,0,0,.35)}
.badge{display:inline-block;padding:.15rem .55rem;border-radius:999px;font-size:.75rem;letter-spacing:.04em;text-transform:uppercase;color:${accent};border:1px solid ${accent}}
p{margin:1rem 0 0}
.hint{margin:1.25rem 0 .5rem;font-size:.9rem;color:#b9b8c6}
input{width:100%;box-sizing:border-box;padding:.55rem .7rem;border:1px solid #3a3948;border-radius:8px;background:#12111a;color:#e6e6ef;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
button{margin-top:.6rem;padding:.45rem .9rem;border:1px solid #3a3948;border-radius:8px;background:#262533;color:#e6e6ef;font:inherit;font-size:.85rem;cursor:pointer}
</style>
</head>
<body>
<div class="card">
<div class="badge">OMTP</div>
<p>${message}</p>${manual}
</div>
</body>
</html>`;
}
