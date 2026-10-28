/**
 * Localised provider names.
 *
 * Only names with an established Chinese form are translated — inventing a name
 * for, say, Anthropic or Groq would be worse than showing the English one. For
 * the rest we translate just the region/qualifier part (`Minimax Cn` →
 * `Minimax 中国`, `(Singapore)` → `（新加坡）`), which stays unambiguous.
 */

/** Providers with an established Chinese name (or a Chinese brand). */
const ZH_NAMES = Object.freeze({
    deepseek: '深度求索',
    moonshot: '月之暗面（Kimi API）',
    'zhipu-coding-plan': '智谱（编码套餐）',
    zai: '智谱国际版（GLM 编码套餐）',
    'zai-coding-plan': '智谱国际版（GLM 编码套餐 · 登录）',
    xiaomi: '小米 MiMo',
    'xiaomi-token-plan-ams': '小米 Token Plan（欧洲）',
    'xiaomi-token-plan-cn': '小米 Token Plan（中国）',
    'xiaomi-token-plan-sgp': '小米 Token Plan（新加坡）',
    siliconflow: '硅基流动',
    'siliconflow-cn': '硅基流动（中国）',
    'qwen-portal': '通义千问门户',
    qianfan: '千帆',
    stepfun: '阶跃星辰',
    nvidia: '英伟达',
    local: '本地模型',
});

/** Region and deployment qualifiers, applied to every provider name. */
const REGION_RULES = Object.freeze([
    [/\bCn\b/g, '中国'],
    [/\bChina\b/g, '中国'],
    [/\bSingapore\b/g, '新加坡'],
    [/\bEurope\b/g, '欧洲'],
    [/\bInternational\b/g, '国际版'],
    [/\(中国\)/g, '（中国）'],
    [/\(新加坡\)/g, '（新加坡）'],
    [/\(欧洲\)/g, '（欧洲）'],
    [/\(国际版\)/g, '（国际版）'],
]);

/**
 * @param {string} locale e.g. `zh-cn`
 * @returns {boolean} Whether provider names have a Chinese form to show.
 */
export function supportsProviderNames(locale) {
    return String(locale || '').toLowerCase().startsWith('zh');
}

/**
 * Display name for a provider.
 * @param {string} providerId
 * @param {string} fallback Label from the catalog.
 * @param {boolean} translate
 * @returns {string}
 */
export function providerDisplayName(providerId, fallback, translate) {
    const label = String(fallback || providerId || '');
    if (!translate) {
        return label;
    }
    const named = ZH_NAMES[String(providerId || '')];
    let text = named || label;
    if (!named) {
        for (const [pattern, replacement] of REGION_RULES) {
            text = text.replace(pattern, replacement);
        }
        // `Label (China)` → `Label（中国）`, not `Label （中国）`.
        text = text.replace(/\s+（/g, '（');
    }
    return text;
}
