/**
 * Compile-time contract checks for the post-translation LLM surface.
 * `tsc --noEmit` fails if a type, default, or error-code member drifts.
 */
import type {
  AppSettings,
  LlmErrorCode,
  LlmProvider,
  LlmProviderConfig,
  LlmSettings,
  LlmStatus,
  LlmTestConnectionRequest,
  LlmTestConnectionResult,
  LlmTranslateRequest,
  LlmTranslateResult
} from './types'
import {
  DEFAULT_LLM_BASE_URLS,
  DEFAULT_LLM_SETTINGS,
  DEFAULT_SETTINGS,
  LLM_ERROR_CODES,
  LLM_PROVIDERS
} from './types'
import type { IpcRequest, IpcResponse } from './ipc'

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
type HasKey<T, K extends string> = K extends keyof T ? true : false

const _providers: Exact<LlmProvider, 'openai' | 'anthropic' | 'gemini'> = true
const _providerList = LLM_PROVIDERS satisfies readonly ['openai', 'anthropic', 'gemini']
void _providers
void _providerList

type ExpectedErrorCode =
  | 'not-configured'
  | 'invalid-config'
  | 'auth'
  | 'forbidden'
  | 'model-not-found'
  | 'rate-limited'
  | 'timeout'
  | 'canceled'
  | 'provider-unavailable'
  | 'malformed-response'
  | 'empty-response'
  | 'refused'
  | 'input-too-long'
  | 'unknown'

const _errorCodes: Exact<LlmErrorCode, ExpectedErrorCode> = true
const _errorList = LLM_ERROR_CODES satisfies readonly ExpectedErrorCode[]
void _errorCodes
void _errorList

const _noProviderApiKey: HasKey<LlmProviderConfig, 'apiKey'> = false
const _noSettingsApiKey: HasKey<AppSettings, 'apiKey'> = false
const _noLlmApiKey: HasKey<LlmSettings, 'apiKey'> = false
void _noProviderApiKey
void _noSettingsApiKey
void _noLlmApiKey

const _defaults = DEFAULT_LLM_SETTINGS satisfies {
  readonly activeProvider: 'openai'
  readonly providers: {
    readonly openai: { readonly modelId: ''; readonly baseUrl: null }
    readonly anthropic: { readonly modelId: ''; readonly baseUrl: null }
    readonly gemini: { readonly modelId: ''; readonly baseUrl: null }
  }
}
const _appLlm: Exact<AppSettings['llm'], LlmSettings> = true
const _appDefault: LlmSettings = DEFAULT_SETTINGS.llm
void _defaults
void _appLlm
void _appDefault

const _baseUrls = DEFAULT_LLM_BASE_URLS satisfies {
  readonly openai: 'https://api.openai.com/v1'
  readonly anthropic: 'https://api.anthropic.com'
  readonly gemini: 'https://generativelanguage.googleapis.com'
}
void _baseUrls

type _Status = LlmStatus
type _TestReq = LlmTestConnectionRequest
type _TestRes = LlmTestConnectionResult
type _TranslateReq = LlmTranslateRequest
type _TranslateRes = LlmTranslateResult
type _SuccessLatency = Extract<LlmTestConnectionResult, { ok: true }>['latencyMs']
const _latency: Exact<_SuccessLatency, number> = true
void _latency

type _GetStatusRes = IpcResponse<'llm:get-status'>
type _SetCredReq = IpcRequest<'llm:set-credential'>
type _DeleteCredReq = IpcRequest<'llm:delete-credential'>
type _TestConnReq = IpcRequest<'llm:test-connection'>
type _TranslateIpc = IpcRequest<'llm:translate'>
type _CancelReq = IpcRequest<'llm:cancel'>
type _GetStatusReq = IpcRequest<'llm:get-status'>

const _voidStatus: Exact<_GetStatusReq, void> = true
const _ipcSurface: [
  _Status,
  _TestReq,
  _TestRes,
  _TranslateReq,
  _TranslateRes,
  _GetStatusRes,
  _SetCredReq,
  _DeleteCredReq,
  _TestConnReq,
  _TranslateIpc,
  _CancelReq
] | undefined = undefined
void _voidStatus
void _ipcSurface
