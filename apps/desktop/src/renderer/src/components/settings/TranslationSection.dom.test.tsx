// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LLM_BASE_URLS,
  DEFAULT_SETTINGS,
  LLM_ERROR_CODES,
  type LlmErrorCode,
  type LlmProvider,
  type LlmStatus,
  type LlmTestConnectionResult
} from '@hubfetch/shared'

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false
    })
  })
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => undefined
  }
})

const ipc = vi.hoisted(() => ({
  invoke: vi.fn<(channel: string, req?: unknown) => Promise<unknown>>()
}))

vi.mock('@/lib/ipc', () => ipc)
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (!opts) return key
      let out = key
      for (const [name, value] of Object.entries(opts)) {
        const token = `{{${name}}}`
        out = out.includes(token) ? out.replace(token, String(value)) : `${out} ${value}`
      }
      return out
    }
  })
}))

import { TranslationSection } from './TranslationSection'
import { useAppStore } from '@/stores/app'
import { useToasts } from '@/components/ui/toaster'

const STORED_KEY = 'sk-stored-secret-aaaa'
const TRANSIENT_KEY = 'sk-transient-bbbbbbbb'

const INITIAL_PROVIDERS = {
  openai: { modelId: 'gpt-4o-mini', baseUrl: null as string | null },
  anthropic: { modelId: 'claude-haiku', baseUrl: null as string | null },
  gemini: { modelId: 'gemini-2.0-flash', baseUrl: null as string | null }
}

type ConfiguredMap = { openai: boolean; anthropic: boolean; gemini: boolean }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function renderSection(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  render(
    <QueryClientProvider client={client}>
      <TranslationSection />
    </QueryClientProvider>
  )
  return client
}

function seedSettings(activeProvider: LlmProvider = 'openai'): void {
  useAppStore.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      llm: { activeProvider, providers: INITIAL_PROVIDERS }
    }
  })
}

function mockIpc(options?: {
  configured?: ConfiguredMap
  testResult?: LlmTestConnectionResult
  testDeferred?: { resolve: (value: LlmTestConnectionResult) => void }
}): { configured: ConfiguredMap } {
  const configured: ConfiguredMap = options?.configured ?? {
    openai: false,
    anthropic: false,
    gemini: false
  }
  ipc.invoke.mockImplementation(async (channel, req) => {
    if (channel === 'llm:get-status') {
      return { configured: { ...configured } } satisfies LlmStatus
    }
    if (channel === 'llm:set-credential' && isRecord(req) && typeof req.provider === 'string') {
      configured[req.provider as LlmProvider] = true
      return { configured: { ...configured } } satisfies LlmStatus
    }
    if (channel === 'llm:delete-credential' && isRecord(req) && typeof req.provider === 'string') {
      configured[req.provider as LlmProvider] = false
      return { configured: { ...configured } } satisfies LlmStatus
    }
    if (channel === 'llm:test-connection') {
      const deferred = options?.testDeferred
      if (deferred) {
        return new Promise<LlmTestConnectionResult>((resolve) => {
          deferred.resolve = resolve
        })
      }
      return options?.testResult ?? { ok: true, latencyMs: 42 }
    }
    if (channel === 'settings:set' && isRecord(req) && isRecord(req.patch)) {
      const current = useAppStore.getState().settings
      return { ...current, ...req.patch }
    }
    throw new Error(`unexpected channel ${channel}`)
  })
  return { configured }
}

function tab(provider: LlmProvider): HTMLElement {
  return screen.getByRole('tab', { name: `settings:translation.providers.${provider}` })
}

function modelField(): HTMLInputElement {
  return screen.getByLabelText('settings:translation.model') as HTMLInputElement
}

function baseUrlField(): HTMLInputElement {
  return screen.getByLabelText('settings:translation.baseUrl') as HTMLInputElement
}

function keyField(): HTMLInputElement {
  return screen.getByLabelText('settings:translation.apiKey') as HTMLInputElement
}

function namedButton(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement
}

afterEach(() => {
  cleanup()
  ipc.invoke.mockReset()
  useToasts.setState({ toasts: [] })
  useAppStore.setState({ settings: DEFAULT_SETTINGS })
})

beforeEach(() => {
  seedSettings()
})

describe('TranslationSection', () => {
  it('shows independent draft fields for each of the three providers', async () => {
    mockIpc()
    renderSection()
    await screen.findByRole('tab', { name: 'settings:translation.providers.openai' })

    expect(modelField().value).toBe('gpt-4o-mini')
    expect(baseUrlField().placeholder).toBe(DEFAULT_LLM_BASE_URLS.openai)

    fireEvent.change(modelField(), { target: { value: 'gpt-custom' } })
    fireEvent.click(tab('anthropic'))
    expect(modelField().value).toBe('claude-haiku')
    expect(baseUrlField().placeholder).toBe(DEFAULT_LLM_BASE_URLS.anthropic)

    fireEvent.click(tab('gemini'))
    expect(modelField().value).toBe('gemini-2.0-flash')
    expect(baseUrlField().placeholder).toBe(DEFAULT_LLM_BASE_URLS.gemini)

    fireEvent.click(tab('openai'))
    expect(modelField().value).toBe('gpt-custom')
  })

  it('persists the selected provider and complete config on Apply', async () => {
    mockIpc()
    renderSection()
    await screen.findByRole('tab', { name: 'settings:translation.providers.openai' })

    fireEvent.click(tab('anthropic'))
    fireEvent.change(modelField(), { target: { value: 'claude-sonnet' } })
    fireEvent.change(baseUrlField(), { target: { value: 'https://api.anthropic.com' } })
    fireEvent.click(namedButton('settings:translation.apply'))

    await waitFor(() => {
      expect(ipc.invoke).toHaveBeenCalledWith('settings:set', {
        patch: {
          llm: {
            activeProvider: 'anthropic',
            providers: {
              openai: { modelId: 'gpt-4o-mini', baseUrl: null },
              anthropic: { modelId: 'claude-sonnet', baseUrl: 'https://api.anthropic.com' },
              gemini: { modelId: 'gemini-2.0-flash', baseUrl: null }
            }
          }
        }
      })
    })
  })

  it('blocks Apply and Test when the base URL is invalid', async () => {
    mockIpc()
    renderSection()
    await screen.findByLabelText('settings:translation.model')
    fireEvent.change(baseUrlField(), { target: { value: 'https://api.openai.com/v1?leak=1' } })
    expect(screen.getByText('settings:translation.invalidUrl')).toBeTruthy()
    expect(namedButton('settings:translation.apply').disabled).toBe(true)
    expect(namedButton('settings:translation.test').disabled).toBe(true)
  })

  it('blocks Test when the model id is empty', async () => {
    mockIpc({ configured: { openai: true, anthropic: false, gemini: false } })
    renderSection()
    await screen.findByLabelText('settings:translation.model')
    fireEvent.change(modelField(), { target: { value: '   ' } })
    expect(screen.getByText('settings:translation.invalidModel')).toBeTruthy()
    expect(namedButton('settings:translation.test').disabled).toBe(true)
  })

  it('preserves the stored key when Save is clicked with a blank password', async () => {
    mockIpc({ configured: { openai: true, anthropic: false, gemini: false } })
    renderSection()
    await screen.findByText('settings:translation.configured')
    fireEvent.click(namedButton('settings:translation.saveKey'))
    expect(ipc.invoke.mock.calls.some((call) => call[0] === 'llm:set-credential')).toBe(false)
    expect(screen.getByText('settings:translation.configured')).toBeTruthy()
  })

  it('sends a transient typed key on Test and omits it when the field is blank', async () => {
    mockIpc({
      configured: { openai: true, anthropic: false, gemini: false },
      testResult: { ok: true, latencyMs: 17 }
    })
    renderSection()
    await screen.findByText('settings:translation.configured')

    fireEvent.change(keyField(), { target: { value: TRANSIENT_KEY } })
    fireEvent.click(namedButton('settings:translation.test'))
    await waitFor(() => {
      expect(ipc.invoke).toHaveBeenCalledWith('llm:test-connection', {
        provider: 'openai',
        modelId: 'gpt-4o-mini',
        baseUrl: null,
        apiKey: TRANSIENT_KEY
      })
    })

    fireEvent.change(keyField(), { target: { value: '' } })
    fireEvent.click(namedButton('settings:translation.test'))
    await waitFor(() => {
      expect(ipc.invoke).toHaveBeenCalledWith('llm:test-connection', {
        provider: 'openai',
        modelId: 'gpt-4o-mini',
        baseUrl: null
      })
    })
  })

  it('deletes only the selected provider key after confirmation', async () => {
    mockIpc({
      configured: { openai: true, anthropic: true, gemini: false }
    })
    renderSection()
    await screen.findByText('settings:translation.configured')

    fireEvent.click(namedButton('settings:translation.deleteKey'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'settings:translation.deleteConfirm' }))

    await waitFor(() => {
      expect(ipc.invoke).toHaveBeenCalledWith('llm:delete-credential', { provider: 'openai' })
    })
    await waitFor(() => {
      expect(screen.getByText('settings:translation.notConfigured')).toBeTruthy()
    })

    fireEvent.click(tab('anthropic'))
    expect(screen.getByText('settings:translation.configured')).toBeTruthy()
    expect(ipc.invoke.mock.calls.filter((call) => call[0] === 'llm:delete-credential')).toHaveLength(
      1
    )
  })

  it('clears the password field after a nonblank Save and never renders a stored key', async () => {
    mockIpc({ configured: { openai: true, anthropic: false, gemini: false } })
    renderSection()
    await screen.findByText('settings:translation.configured')

    expect(keyField().type).toBe('password')
    expect(keyField().value).toBe('')
    expect(document.body.textContent).not.toContain(STORED_KEY)

    fireEvent.change(keyField(), { target: { value: TRANSIENT_KEY } })
    fireEvent.click(namedButton('settings:translation.saveKey'))
    await waitFor(() => {
      expect(ipc.invoke).toHaveBeenCalledWith('llm:set-credential', {
        provider: 'openai',
        apiKey: TRANSIENT_KEY
      })
    })
    await waitFor(() => {
      expect(keyField().value).toBe('')
    })
    expect(document.body.textContent).not.toContain(TRANSIENT_KEY)
    expect(document.body.textContent).not.toContain(STORED_KEY)
  })

  it('shows success latency after a connection test', async () => {
    mockIpc({
      configured: { openai: true, anthropic: false, gemini: false },
      testResult: { ok: true, latencyMs: 88 }
    })
    renderSection()
    await screen.findByText('settings:translation.configured')
    fireEvent.click(namedButton('settings:translation.test'))
    expect((await screen.findByRole('status')).textContent).toContain('88')
  })

  it('shows a loading state while the probe is in flight', async () => {
    const testDeferred: { resolve: (value: LlmTestConnectionResult) => void } = {
      resolve: () => undefined
    }
    mockIpc({
      configured: { openai: true, anthropic: false, gemini: false },
      testDeferred
    })
    renderSection()
    await screen.findByText('settings:translation.configured')
    fireEvent.click(namedButton('settings:translation.test'))
    await waitFor(() => {
      expect(namedButton('settings:translation.test').getAttribute('aria-busy')).toBe('true')
    })
    testDeferred.resolve({ ok: true, latencyMs: 3 })
    expect((await screen.findByRole('status')).textContent).toContain('3')
  })

  it.each(LLM_ERROR_CODES)('surfaces typed test error %s', async (code: LlmErrorCode) => {
    mockIpc({
      configured: { openai: true, anthropic: false, gemini: false },
      testResult: { ok: false, error: code }
    })
    renderSection()
    await screen.findByText('settings:translation.configured')
    fireEvent.click(namedButton('settings:translation.test'))
    expect(await screen.findByText(`settings:translation.errors.${code}`)).toBeTruthy()
  })

  it('guides the user when no key is available to test', async () => {
    mockIpc()
    renderSection()
    await screen.findByText('settings:translation.notConfigured')
    expect(screen.getByText('settings:translation.noKey')).toBeTruthy()
    expect(namedButton('settings:translation.test').disabled).toBe(true)
    expect(screen.getByText('settings:translation.testHint')).toBeTruthy()
  })
})
