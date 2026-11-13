/**
 * Gateway adapter identifiers supported by OMTP.
 * Kept in a zero-dependency leaf module so catalog validation, safety helpers,
 * provider config and the adapter registry share one source of truth.
 */
export const ADAPTER_IDS = Object.freeze([
    'openai',
    'anthropic',
    'google',
    'google-vertex',
    'antigravity',
    'responses',
    'azure-responses',
    'bedrock',
    'ollama',
]);
