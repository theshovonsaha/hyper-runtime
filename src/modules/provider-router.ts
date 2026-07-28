/**
 * modules/provider-router.ts — Standalone Multi-LLM Provider Router & Rate-Limit Fallback Service.
 */

export { buildProvider, nextFallbackProvider, MockProvider, ProviderError, RateLimitError } from '../providers/base';
export type { Provider } from '../providers/base';
export { capabilitiesFor } from '../core/capabilities';
export type { Capabilities } from '../core/capabilities';
