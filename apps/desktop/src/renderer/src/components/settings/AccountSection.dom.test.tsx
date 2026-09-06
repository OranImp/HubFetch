// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HUB_ENDPOINT, DEFAULT_SETTINGS, type AccountSummary, type AuthState } from '@hubfetch/shared'

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

import { AccountSection } from './AccountSection'
import { useAppStore } from '@/stores/app'
import { useToasts } from '@/components/ui/toaster'

const TOKEN_A = 'hf_secret_alice_aaaaaaaa'

function account(
  id: string,
  name: string,
  extra: Partial<AccountSummary> = {}
): AccountSummary {
  return {
    id,
    endpoint: DEFAULT_HUB_ENDPOINT,
    user: { name, fullname: name, orgs: [] },
    tokenDisplayName: `${name}-token`,
    tokenRole: 'write',
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
    method: 'token',
    tokenDisplayName: `${name}-token`,
    tokenRole: 'write'
  }
}

function renderSection(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AccountSection />
      </MemoryRouter>
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
    auth: { status: 'signedOut' }
  })
})

describe('AccountSection', () => {
  it('keeps the token field password-only, clears it after submit, and never echoes the secret', async () => {
    let stored: AccountSummary[] = []
    ipc.invoke.mockImplementation(async (channel, req) => {
      if (channel === 'auth:listAccounts') return stored
      if (channel === 'hub:billingUsage') return { rows: [] }
      if (channel === 'auth:signInWithToken' && isRecord(req) && req.token === TOKEN_A) {
        stored = [account('a', 'alice', { active: true })]
        return { ok: true, state: signedIn('alice', 'a') }
      }
      throw new Error(`unexpected ${channel}`)
    })
    renderSection()
    const field = screen.getByPlaceholderText('auth:tokenSignIn.placeholder') as HTMLInputElement
    expect(field.type).toBe('password')
    fireEvent.change(field, { target: { value: TOKEN_A } })
    fireEvent.submit(field.closest('form') ?? field)
    await waitFor(() => {
      expect(useAppStore.getState().auth.status).toBe('signedIn')
    })
    expect(field.value).toBe('')
    expect(document.body.textContent ?? '').not.toContain(TOKEN_A)
  })

  it('dedupes adding the same token into a single list row', async () => {
    const alice = account('a', 'alice', { active: true })
    let stored = [alice]
    ipc.invoke.mockImplementation(async (channel, req) => {
      if (channel === 'auth:listAccounts') return stored
      if (channel === 'auth:signInWithToken') {
        stored = [alice]
        return { ok: true, state: signedIn('alice', 'a') }
      }
      if (channel === 'hub:billingUsage') return { rows: [] }
      throw new Error(`unexpected ${channel} ${JSON.stringify(req)}`)
    })
    useAppStore.setState({ auth: signedIn('alice', 'a') })
    renderSection()
    await screen.findByText('alice')
    fireEvent.click(screen.getByRole('button', { name: 'settings:account.accounts.addAccount' }))
    const field = screen.getByPlaceholderText('auth:tokenSignIn.placeholder')
    fireEvent.change(field, { target: { value: TOKEN_A } })
    fireEvent.submit(field.closest('form') ?? field)
    await waitFor(() => {
      expect(screen.getAllByRole('listitem')).toHaveLength(1)
    })
  })

  it('lists A and B without marking B active until switch validates', async () => {
    const alice = account('a', 'alice', { active: true })
    const bob = account('b', 'bob')
    let resolveSwitch: ((value: unknown) => void) | undefined
    ipc.invoke.mockImplementation(async (channel, req) => {
      if (channel === 'auth:listAccounts') return [alice, bob]
      if (channel === 'hub:billingUsage') return { rows: [] }
      if (channel === 'auth:switchAccount' && isRecord(req) && req.accountId === 'b') {
        return new Promise((resolve) => {
          resolveSwitch = resolve
        })
      }
      throw new Error(`unexpected ${channel}`)
    })
    useAppStore.setState({ auth: signedIn('alice', 'a') })
    renderSection()
    const bobRow = await screen.findByRole('listitem', { name: undefined })
    const rows = screen.getAllByRole('listitem')
    const aliceEl = rows.find((row) => row.getAttribute('data-account-id') === 'a') ?? rows[0]
    const bobEl = rows.find((row) => row.getAttribute('data-account-id') === 'b') ?? bobRow
    expect(aliceEl).toBeTruthy()
    fireEvent.click(within(bobEl).getByRole('button', { name: 'settings:account.accounts.switch' }))
    await waitFor(() => {
      expect(bobEl.querySelector('[data-account-pending="true"]')).not.toBeNull()
    })
    expect(aliceEl?.querySelector('[data-account-active="true"]')).not.toBeNull()
    expect(bobEl.querySelector('[data-account-active="true"]')).toBeNull()
    expect(resolveSwitch).toBeTypeOf('function')
  })

  it('applies a validated A→B switch only after success', async () => {
    const alice = account('a', 'alice', { active: true })
    const bob = account('b', 'bob')
    let stored = [alice, bob]
    ipc.invoke.mockImplementation(async (channel, req) => {
      if (channel === 'auth:listAccounts') return stored
      if (channel === 'hub:billingUsage') return { rows: [] }
      if (channel === 'auth:switchAccount' && isRecord(req) && req.accountId === 'b') {
        stored = [account('a', 'alice'), account('b', 'bob', { active: true })]
        return { ok: true, state: signedIn('bob', 'b') }
      }
      throw new Error(`unexpected ${channel}`)
    })
    useAppStore.setState({ auth: signedIn('alice', 'a') })
    const client = renderSection()
    client.setQueryData(['repo', 'model', 'org/name'], { id: 'from-a' })
    client.setQueryData(['favorites'], [{ repoId: 'kept' }])
    client.setQueryData(['history'], [{ repoId: 'kept-hist' }])
    const bobEl = (await screen.findAllByRole('listitem')).find((row) =>
      (row.textContent ?? '').includes('bob')
    )
    expect(bobEl).toBeTruthy()
    fireEvent.click(within(bobEl ?? document.body).getByRole('button', { name: 'settings:account.accounts.switch' }))
    await waitFor(() => {
      expect(useAppStore.getState().auth).toMatchObject({ status: 'signedIn', accountId: 'b' })
    })
    expect(client.getQueryData(['repo', 'model', 'org/name'])).toBe(undefined)
    expect(client.getQueryData(['favorites'])).toEqual([{ repoId: 'kept' }])
    expect(client.getQueryData(['history'])).toEqual([{ repoId: 'kept-hist' }])
  })

  it('keeps the active account on a transient network switch failure', async () => {
    ipc.invoke.mockImplementation(async (channel, req) => {
      if (channel === 'auth:listAccounts') {
        return [account('a', 'alice', { active: true }), account('b', 'bob')]
      }
      if (channel === 'hub:billingUsage') return { rows: [] }
      if (channel === 'auth:switchAccount') return { ok: false, error: 'network' }
      throw new Error(`unexpected ${channel} ${JSON.stringify(req)}`)
    })
    useAppStore.setState({ auth: signedIn('alice', 'a') })
    renderSection()
    const bobEl = (await screen.findAllByRole('listitem')).find((row) =>
      (row.textContent ?? '').includes('bob')
    )
    fireEvent.click(within(bobEl ?? document.body).getByRole('button', { name: 'settings:account.accounts.switch' }))
    await waitFor(() => {
      expect(useToasts.getState().toasts.some((toast) => toast.message.includes('network'))).toBe(
        true
      )
    })
    expect(useAppStore.getState().auth).toMatchObject({ status: 'signedIn', accountId: 'a' })
  })

  it('keeps the active account on a 401 invalid switch', async () => {
    ipc.invoke.mockImplementation(async (channel) => {
      if (channel === 'auth:listAccounts') {
        return [account('a', 'alice', { active: true }), account('b', 'bob', { invalid: true })]
      }
      if (channel === 'hub:billingUsage') return { rows: [] }
      if (channel === 'auth:switchAccount') return { ok: false, error: 'invalid', accountId: 'b' }
      throw new Error(`unexpected ${channel}`)
    })
    useAppStore.setState({ auth: signedIn('alice', 'a') })
    renderSection()
    const bobEl = (await screen.findAllByRole('listitem')).find((row) =>
      (row.textContent ?? '').includes('bob')
    )
    fireEvent.click(within(bobEl ?? document.body).getByRole('button', { name: 'settings:account.accounts.switch' }))
    await waitFor(() => {
      expect(useToasts.getState().toasts.some((toast) => toast.message.includes('invalid'))).toBe(
        true
      )
    })
    expect(useAppStore.getState().auth).toMatchObject({ accountId: 'a' })
  })

  it('disables endpoint-mismatched accounts and offers Network settings', async () => {
    ipc.invoke.mockImplementation(async (channel) => {
      if (channel === 'auth:listAccounts') {
        return [
          account('a', 'alice', { active: true }),
          account('b', 'bob', { endpoint: 'https://hf.example' })
        ]
      }
      if (channel === 'hub:billingUsage') return { rows: [] }
      throw new Error(`unexpected ${channel}`)
    })
    useAppStore.setState({ auth: signedIn('alice', 'a') })
    renderSection()
    const bobEl = (await screen.findAllByRole('listitem')).find((row) =>
      (row.textContent ?? '').includes('bob')
    )
    expect(within(bobEl ?? document.body).queryByRole('button', { name: 'settings:account.accounts.switch' })).toBeNull()
    expect(
      within(bobEl ?? document.body).getByRole('button', { name: 'settings:account.accounts.openNetwork' })
    ).toBeTruthy()
  })

  it('shows typed subsystem counts and keeps remove disabled while the account is in use', async () => {
    ipc.invoke.mockImplementation(async (channel, req) => {
      if (channel === 'auth:listAccounts') {
        return [account('a', 'alice', { active: true }), account('b', 'bob')]
      }
      if (channel === 'hub:billingUsage') return { rows: [] }
      if (channel === 'auth:removeAccount' && isRecord(req) && req.accountId === 'b') {
        return {
          ok: false,
          error: 'account-in-use',
          accountId: 'b',
          counts: { downloads: 2, clones: 1, uploads: 0, total: 3 }
        }
      }
      throw new Error(`unexpected ${channel}`)
    })
    useAppStore.setState({ auth: signedIn('alice', 'a') })
    renderSection()
    const bobEl = (await screen.findAllByRole('listitem')).find((row) =>
      (row.textContent ?? '').includes('bob')
    )
    fireEvent.click(within(bobEl ?? document.body).getByRole('button', { name: 'settings:account.accounts.remove' }))
    fireEvent.click(
      within(bobEl ?? document.body).getByRole('button', { name: 'settings:account.accounts.confirmRemove' })
    )
    await waitFor(() => {
      expect(within(bobEl ?? document.body).getByRole('status').textContent).toContain('downloads=2')
    })
    expect(
      (
        within(bobEl ?? document.body).getByRole('button', {
          name: 'settings:account.accounts.confirmRemove'
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
  })

  it('signs out the active account without promoting a fallback', async () => {
    let stored = [account('a', 'alice', { active: true }), account('b', 'bob')]
    ipc.invoke.mockImplementation(async (channel) => {
      if (channel === 'auth:listAccounts') return stored
      if (channel === 'hub:billingUsage') return { rows: [] }
      if (channel === 'auth:signOut') {
        stored = [account('b', 'bob')]
        return { status: 'signedOut' }
      }
      throw new Error(`unexpected ${channel}`)
    })
    useAppStore.setState({ auth: signedIn('alice', 'a') })
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'auth:signOut' }))
    const confirm = screen.getAllByRole('button', { name: 'auth:signOut' }).at(-1)
    expect(confirm).toBeTruthy()
    fireEvent.click(confirm ?? screen.getByRole('button', { name: 'auth:signOut' }))
    await waitFor(() => {
      expect(useAppStore.getState().auth).toEqual({ status: 'signedOut' })
    })
    expect(screen.getByText('bob')).toBeTruthy()
    expect(screen.queryByText('alice')).toBeNull()
  })

  it('connects and disconnects the Hub web session on the active account', async () => {
    let stored = [account('a', 'alice', { active: true, hubSession: false })]
    ipc.invoke.mockImplementation(async (channel) => {
      if (channel === 'auth:listAccounts') return stored
      if (channel === 'hub:billingUsage') return { rows: [] }
      if (channel === 'auth:connectHubSession') {
        stored = [account('a', 'alice', { active: true, hubSession: true })]
        return { ok: true, state: { ...signedIn('alice', 'a'), hubSession: true } }
      }
      if (channel === 'auth:disconnectHubSession') {
        stored = [account('a', 'alice', { active: true, hubSession: false })]
        return signedIn('alice', 'a')
      }
      throw new Error(`unexpected ${channel}`)
    })
    useAppStore.setState({ auth: signedIn('alice', 'a') })
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: 'auth:hubSession.connect' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'auth:hubSession.disconnect' })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: 'auth:hubSession.disconnect' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'auth:hubSession.connect' })).toBeTruthy()
    })
  })
})
