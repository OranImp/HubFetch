/**
 * Provider config normalization.
 *
 * - Trims whitespace from model IDs and base URLs.
 * - Resolves the effective base URL (custom or DEFAULT_LLM_BASE_URLS).
 */
import type { LlmProvider, LlmProviderConfig } from '@hubfetch/shared'
import { DEFAULT_LLM_BASE_URLS } from '@hubfetch/shared'

/**
 * Normalize a provider config by trimming whitespace from modelId and baseUrl.
 * Preserves null baseUrl (meaning "use the default").
 */
export function normalizeProviderConfig(
  _provider: LlmProvider,
  config: LlmProviderConfig,
): LlmProviderConfig {
  return {
    modelId: config.modelId.trim(),
    baseUrl: config.baseUrl === null ? null : config.baseUrl.trim(),
  }
}

/**
 * Resolve the effective base URL for a provider.
 * Returns the custom baseUrl if set, otherwise the provider's built-in default.
 */
export function resolveBaseUrl(
  provider: LlmProvider,
  config: LlmProviderConfig,
): string {
  return config.baseUrl ?? DEFAULT_LLM_BASE_URLS[provider]
}