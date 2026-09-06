// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HUB_ENDPOINT, DEFAULT_SETTINGS, type AccountSummary, type AuthState } from '@hubfetch/shared'
import { TooltipProvider } from '@/components/ui/tooltip'

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
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => undefined
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => undefined
  }
})

const ipc = vi.hoisted(() => ({
  invoke: vi.fn<(channel: string, req?: unknown) => Promise<unknown>>()
}))

vi.mock('@/lib/ipc', () => ({
  invoke: ipc.invoke,
  openExternal: vi.fn()
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (!opts) return key
      let out = key
      for (const [name, value] of Object.entries(opts)) {
        out = `${out} ${name}=${String(value)}`
      }
      return out
    }
  })
}))

import { AccountChip } from './AccountChip'
import { useAppStore } from '@/stores/app'
import { useToasts } from '@/components/ui/toaster'

function account(
  id: string,
  name: string,
  extra: Partial<AccountSummary> = {}
): AccountSummary {
  return {
    id,
    endpoint: DEFAULT_HUB_ENDPOINT,
    user: { name, fullname: name, orgs: [] },
    hubSession: false,
    active: false,
    ...extra
  }
}

function signedIn(name: string, accountId: string): AuthState {
  return {
    status: 'signedIn',
    accountId,
    user: { name, fullname: name, orgs: [] },
    method: 'token'
  }
}

function renderChip(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <AccountChip />
      </TooltipProvider>
    </QueryClientProvider>
  )
  return client
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

afterEach(() => {
  cleanup()
  useToasts.setState({ toasts: [] })
})

beforeEach(() => {
  ipc.invoke.mockReset()
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, hubEndpoint: DEFAULT_HUB_ENDPOINT },
    auth: signedIn('alice', 'a')
  })
})

describe('AccountChip', () => {
  it('shows pending on B without rendering B as active before validation completes', async () => {
    let resolveSwitch: ((value: unknown) => void) | undefined
    ipc.invoke.mockImplementation(async (channel, req) => {
      if (channel === 'auth:listAccounts') {
        return [account('a', 'alice', { active: true }), account('b', 'bob')]
      }
      if (channel === 'auth:switchAccount' && isRecord(req) && req.accountId === 'b') {
        return new Promise((resolve) => {
          resolveSwitch = resolve
        })
      }
      throw new Error(`unexpected ${channel}`)
    })
    renderChip()
    fireEvent.click(screen.getByRole('button'))
    const bobItem = await screen.findByText('bob')
    fireEvent.click(bobItem)
    await waitFor(() => {
      expect(document.querySelector('[data-account-id="b"][data-account-pending="true"]')).not.toBe(
        null
      )
    })
    expect(document.querySelector('[data-account-id="b"][data-account-active="true"]')).toBeNull()
    expect(document.querySelector('[data-account-id="a"][data-account-active="true"]')).not.toBeNull()
    expect(useAppStore.getState().auth).toMatchObject({ accountId: 'a' })
    expect(resolveSwitch).toBeTypeOf('function')
  })

  it('opens Network settings from an endpoint-mismatched menu', async () => {
    ipc.invoke.mockImplementation(async (channel) => {
      if (channel === 'auth:listAccounts') {
        return [
          account('a', 'alice', { active: true }),
          account('b', 'bob', { endpoint: 'https://hf.example' })
        ]
      }
      throw new Error(`unexpected ${channel}`)
    })
    renderChip()
    fireEvent.click(screen.getByRole('button'))
    await screen.findByText('bob')
    fireEvent.click(screen.getByText('settings:account.accounts.openNetwork'))
    expect(useAppStore.getState().settingsOpen).toBe(true)
    expect(useAppStore.getState().settingsSection).toBe('network')
  })
})
