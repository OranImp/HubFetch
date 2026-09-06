/**
 * LlmAdapter — provider-neutral interface for connection testing and translation.
 *
 * Every provider adapter (OpenAI, Anthropic, Gemini) implements this contract.
 * The coordinator (Todo 9) dispatches to the active adapter through this seam.
 */
import type { LlmProvider, LlmProviderConfig, LlmTestConnectionResult, LlmTranslateRequest, LlmTranslateResult } from '@hubfetch/shared'

export interface LlmAdapter {
  /** Provider identity — must match the credential/config key. */
  readonly provider: LlmProvider

  /**
   * Run a minimal generation probe on the configured model.
   * Returns latency on success or a typed error code.
   * The caller MUST register the config's API key (if any) with the secret
   * registry before invoking this method.
   */
  testConnection(config: LlmProviderConfig, signal: AbortSignal): Promise<LlmTestConnectionResult>

  /**
   * Translate the given Markdown content to the target locale.
   * Returns a parsed translation envelope or an error result.
   * The caller owns the AbortSignal lifecycle.
   */
  translate(request: LlmTranslateRequest, signal: AbortSignal): Promise<LlmTranslateResult>
}