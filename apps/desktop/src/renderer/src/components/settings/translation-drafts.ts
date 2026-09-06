import {
  LLM_PROVIDERS,
  type LlmErrorCode,
  type LlmProvider,
  type LlmProviderConfig,
  type LlmSettings
} from '@hubfetch/shared'

export type ProviderDraft = { modelId: string; baseUrl: string; apiKey: string }
export type Drafts = Record<LlmProvider, ProviderDraft>
export type TestView =
  | { readonly kind: 'idle' }
  | { readonly kind: 'ok'; readonly latencyMs: number }
  | { readonly kind: 'error'; readonly code: LlmErrorCode }

export function isLlmProvider(value: string): value is LlmProvider {
  return LLM_PROVIDERS.some((provider) => provider === value)
}

export function parseBaseUrl(raw: string): { ok: true; value: string | null } | { ok: false } {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, value: null }
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false }
    if (parsed.username !== '' || parsed.password !== '') return { ok: false }
    if (parsed.search !== '' || parsed.hash !== '') return { ok: false }
    if (parsed.hostname === '') return { ok: false }
    return { ok: true, value: trimmed.replace(/\/$/, '') }
  } catch {
    return { ok: false }
  }
}

export function draftsFromSettings(llm: LlmSettings): Drafts {
  const from = (config: LlmProviderConfig): ProviderDraft => ({
    modelId: config.modelId,
    baseUrl: config.baseUrl ?? '',
    apiKey: ''
  })
  return {
    openai: from(llm.providers.openai),
    anthropic: from(llm.providers.anthropic),
    gemini: from(llm.providers.gemini)
  }
}

export function keepKeys(prev: Drafts, llm: LlmSettings): Drafts {
  const next = draftsFromSettings(llm)
  return {
    openai: { ...next.openai, apiKey: prev.openai.apiKey },
    anthropic: { ...next.anthropic, apiKey: prev.anthropic.apiKey },
    gemini: { ...next.gemini, apiKey: prev.gemini.apiKey }
  }
}

export function configFromDraft(draft: ProviderDraft): LlmProviderConfig | null {
  const parsed = parseBaseUrl(draft.baseUrl)
  if (!parsed.ok) return null
  return { modelId: draft.modelId.trim(), baseUrl: parsed.value }
}

export function testErrorKey(code: LlmErrorCode): `settings:translation.errors.${LlmErrorCode}` {
  return `settings:translation.errors.${code}`
}

export function assertNever(value: never): never {
  throw new Error(`unexpected value: ${String(value)}`)
}
