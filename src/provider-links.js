/**
 * Where to create an API key for a provider.
 *
 * Only providers with a known, stable console page are listed; guessing a URL
 * from the base host sends users to a 404, so unknown providers simply get no
 * button. Keys are the catalog's provider ids.
 */
const API_KEY_URLS = Object.freeze({
    'aimlapi': 'https://aimlapi.com/app/keys',
    'amazon-bedrock': 'https://console.aws.amazon.com/bedrock/home#/api-keys',
    'anthropic': 'https://console.anthropic.com/settings/keys',
    'azure': 'https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub',
    'baseten': 'https://www.baseten.co/settings/api-keys',
    'cerebras': 'https://cloud.cerebras.ai/',
    'cloudflare-ai-gateway': 'https://dash.cloudflare.com/profile/api-tokens',
    'cloudflare-workers-ai': 'https://dash.cloudflare.com/profile/api-tokens',
    'coreweave': 'https://console.coreweave.com/',
    'deepinfra': 'https://deepinfra.com/dash/api_keys',
    'deepseek': 'https://platform.deepseek.com/api_keys',
    'fireworks': 'https://fireworks.ai/account/api-keys',
    'google': 'https://aistudio.google.com/app/apikey',
    'google-vertex': 'https://console.cloud.google.com/apis/credentials',
    'groq': 'https://console.groq.com/keys',
    'huggingface': 'https://huggingface.co/settings/tokens',
    'inception': 'https://platform.inceptionlabs.ai/',
    'minimax': 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    'minimax-cn': 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    'mistral': 'https://console.mistral.ai/api-keys',
    'moonshot': 'https://platform.moonshot.cn/console/api-keys',
    'nanogpt': 'https://nano-gpt.com/api',
    'novita': 'https://novita.ai/settings/key-management',
    'nvidia': 'https://build.nvidia.com/',
    'openai': 'https://platform.openai.com/api-keys',
    'openrouter': 'https://openrouter.ai/keys',
    'qianfan': 'https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application',
    'qwen-portal': 'https://bailian.console.aliyun.com/',
    'sambanova': 'https://cloud.sambanova.ai/apis',
    'stepfun': 'https://platform.stepfun.com/interface-key',
    'together': 'https://api.together.xyz/settings/api-keys',
    'venice': 'https://venice.ai/settings/api',
    'vercel-ai-gateway': 'https://vercel.com/dashboard/ai-gateway',
    'xai': 'https://console.x.ai/',
    'zai': 'https://z.ai/manage-apikey/apikey-list',
});

/**
 * Console page that issues keys for a provider.
 * @param {string} providerId
 * @returns {string|null}
 */
export function apiKeyUrlFor(providerId) {
    const id = String(providerId || '').trim();
    if (!id) {
        return null;
    }
    return API_KEY_URLS[id] || null;
}
