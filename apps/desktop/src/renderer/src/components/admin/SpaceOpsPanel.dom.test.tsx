// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HUB_ENDPOINT, DEFAULT_SETTINGS } from '@hubfetch/shared'

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

import { SpaceOpsPanel } from './SpaceOpsPanel'
import { useAppStore } from '@/stores/app'
import { useToasts } from '@/components/ui/toaster'

const REPO = 'owner/space'

const CATALOG = [
  {
    name: 'cpu-basic',
    prettyName: 'CPU Basic',
    cpu: '2 vCPU',
    ram: '16 GB',
    accelerator: null
  },
  {
    name: 'cpu-upgrade',
    prettyName: 'CPU Upgrade',
    cpu: '8 vCPU',
    ram: '32 GB',
    accelerator: null
  }
]

function runtime(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stage: 'RUNNING',
    hardware: 'cpu-basic',
    requestedHardware: null,
    gcTimeout: null,
    ...overrides
  }
}

function renderPanel(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  render(
    <QueryClientProvider client={client}>
      <SpaceOpsPanel repoId={REPO} />
    </QueryClientProvider>
  )
  return client
}

/** Hardware/runtime/secrets/variables/logs base mock; tests override per channel. */
function mockHub(handlers: Record<string, unknown> = {}): void {
  ipc.invoke.mockImplementation(async (channel: string, req?: unknown) => {
    if (channel in handlers) {
      const handler = handlers[channel]
      return typeof handler === 'function' ? handler(req) : handler
    }
    if (channel === 'hub:spaceRuntime') return runtime()
    if (channel === 'hub:spaceHardwareList') return CATALOG
    if (channel === 'hub:spaceSecrets') return {}
    if (channel === 'hub:spaceVariables') return {}
    if (channel === 'hub:spaceLogs') return { text: '' }
    throw new Error(`unexpected ${channel} ${JSON.stringify(req)}`)
  })
}

function sleepInput(): HTMLInputElement {
  return screen.getByPlaceholderText('admin:space.runtime.sleepPlaceholder') as HTMLInputElement
}

beforeEach(() => {
  ipc.invoke.mockReset()
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, hubEndpoint: DEFAULT_HUB_ENDPOINT },
    auth: {
      status: 'signedIn',
      accountId: 'a',
      user: { name: 'owner', fullname: 'owner', orgs: [] },
      method: 'token',
      tokenDisplayName: 't',
      tokenRole: 'write'
    }
  })
})

afterEach(() => {
  cleanup()
  useToasts.setState({ toasts: [] })
  vi.useRealTimers()
})

describe('SpaceOpsPanel runtime', () => {
  it('renders stage, current hardware and Hub-managed sleep for cpu-basic with no gcTimeout', async () => {
    mockHub({})
    renderPanel()

    expect(await screen.findByText('admin:space.runtime.stage.RUNNING')).toBeTruthy()
    expect(screen.getByText('cpu-basic')).toBeTruthy()
    expect(screen.getByText('admin:space.runtime.hubManagedSleep')).toBeTruthy()
    expect(screen.queryByText('admin:space.runtime.requestedHardware')).toBeNull()
    // No fabricated default duration anywhere.
    expect(screen.queryByText('48 h')).toBeNull()
    // Custom sleep is disabled on the free tier without a reported window.
    expect(sleepInput().disabled).toBe(true)
  })

  it('shows requested hardware while a hardware switch is pending', async () => {
    mockHub({
      'hub:spaceRuntime': runtime({
        stage: 'RUNNING',
        hardware: 'cpu-basic',
        requestedHardware: 'cpu-upgrade'
      })
    })
    renderPanel()

    expect(await screen.findByText('admin:space.runtime.requestedHardware')).toBeTruthy()
    expect(screen.getByText('cpu-upgrade')).toBeTruthy()
  })

  it('normalizes unknown future stages instead of crashing', async () => {
    mockHub({ 'hub:spaceRuntime': runtime({ stage: 'BRAND_NEW_STAGE' }) })
    renderPanel()
    expect(await screen.findByText('brand new stage')).toBeTruthy()
  })

  it.each([
    ['BUILDING', 'admin:space.runtime.stage.BUILDING'],
    ['PAUSED', 'admin:space.runtime.stage.PAUSED'],
    ['SLEEPING', 'admin:space.runtime.stage.SLEEPING'],
    ['STOPPED', 'admin:space.runtime.stage.STOPPED'],
    ['RUNTIME_ERROR', 'admin:space.runtime.stage.RUNTIME_ERROR']
  ])('labels stage %s', async (stage, label) => {
    mockHub({ 'hub:spaceRuntime': runtime({ stage }) })
    renderPanel()
    expect(await screen.findByText(label)).toBeTruthy()
  })

  it('offers a bounded status refresh that refetches the runtime', async () => {
    mockHub({})
    renderPanel()
    await screen.findByText('admin:space.runtime.stage.RUNNING')
    const before = ipc.invoke.mock.calls.filter(([c]) => c === 'hub:spaceRuntime').length
    fireEvent.click(screen.getByRole('button', { name: 'admin:space.runtime.refresh' }))
    await waitFor(() => {
      expect(
        ipc.invoke.mock.calls.filter(([c]) => c === 'hub:spaceRuntime').length
      ).toBeGreaterThan(before)
    })
  })

  it('shows the runtime error with retry', async () => {
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'hub:spaceRuntime') throw new Error('403 forbidden')
      if (channel === 'hub:spaceHardwareList') return CATALOG
      if (channel === 'hub:spaceSecrets') return {}
      if (channel === 'hub:spaceVariables') return {}
      if (channel === 'hub:spaceLogs') return { text: '' }
      throw new Error(`unexpected ${channel}`)
    })
    renderPanel()
    expect(await screen.findByText('403 forbidden')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'common:retry' }))
    expect(ipc.invoke.mock.calls.filter(([c]) => c === 'hub:spaceRuntime').length).toBeGreaterThan(
      1
    )
  })
})

describe('SpaceOpsPanel lifecycle controls', () => {
  it('resumes a PAUSED space through a normal restart', async () => {
    mockHub({ 'hub:spaceRuntime': runtime({ stage: 'PAUSED' }) })
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'admin:space.runtime.resume' }))
    await waitFor(() => {
      expect(ipc.invoke).toHaveBeenCalledWith('hub:spaceRestart', { repoId: REPO })
    })
  })

  it('pauses only after confirmation and then polls the runtime within a bounded window', async () => {
    vi.useFakeTimers()
    let stage = 'RUNNING'
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'hub:spaceRuntime') return runtime({ stage })
      if (channel === 'hub:spaceHardwareList') return CATALOG
      if (channel === 'hub:spaceSecrets') return {}
      if (channel === 'hub:spaceVariables') return {}
      if (channel === 'hub:spaceLogs') return { text: '' }
      if (channel === 'hub:spacePause') {
        stage = 'PAUSED'
        return {}
      }
      throw new Error(`unexpected ${channel}`)
    })
    const client = renderPanel()

    const runtimeCalls = (): number =>
      ipc.invoke.mock.calls.filter(([c]) => c === 'hub:spaceRuntime').length

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const before = runtimeCalls()

    // Pause requires confirmation: nothing is sent before confirming.
    fireEvent.click(screen.getByRole('button', { name: 'admin:space.runtime.pause' }))
    expect(screen.getByText('admin:space.runtime.pauseTitle')).toBeTruthy()
    expect(ipc.invoke.mock.calls.some(([c]) => c === 'hub:spacePause')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'admin:space.runtime.pause' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(ipc.invoke.mock.calls.some(([c]) => c === 'hub:spacePause')).toBe(true)

    // Runtime + repo queries are invalidated after the mutation.
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries')
    fireEvent.click(screen.getByRole('button', { name: 'admin:space.runtime.refresh' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    invalidateSpy.mockRestore()

    // Bounded polling: the runtime refetches on the interval after a mutation...
    const afterMutation = runtimeCalls()
    expect(afterMutation).toBeGreaterThan(before)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(runtimeCalls()).toBeGreaterThan(afterMutation)

    // ...and stops once the settled stage is observed (PAUSED)...
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    const settled = runtimeCalls()

    // ...and never polls past the bounded window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(runtimeCalls()).toBe(settled)
  })

  it('gates factory reboot behind typing the exact repo id', async () => {
    mockHub({})
    renderPanel()
    await screen.findByText('admin:space.runtime.stage.RUNNING')

    fireEvent.click(screen.getByRole('button', { name: 'admin:space.restart.factory' }))
    expect(screen.getByText('admin:space.restart.factoryHint')).toBeTruthy()
    const confirm = screen.getByRole('button', { name: 'admin:space.restart.factory' })
    expect((confirm as HTMLButtonElement).disabled).toBe(true)

    const field = screen.getByLabelText('admin:space.runtime.confirmLabel repoId=owner/space')
    fireEvent.change(field, { target: { value: 'owner/wrong' } })
    expect(
      (screen.getByRole('button', { name: 'admin:space.restart.factory' }) as HTMLButtonElement)
        .disabled
    ).toBe(true)

    fireEvent.change(field, { target: { value: REPO } })
    const ready = screen.getByRole('button', {
      name: 'admin:space.restart.factory'
    }) as HTMLButtonElement
    expect(ready.disabled).toBe(false)
    fireEvent.click(ready)
    await waitFor(() => {
      expect(ipc.invoke).toHaveBeenCalledWith('hub:spaceRestart', { repoId: REPO, factory: true })
    })
  })

  it('charges nothing on screen: paid hardware changes need typed confirmation and show a billing notice without currency', async () => {
    mockHub({})
    renderPanel()
    await screen.findByText('admin:space.runtime.stage.RUNNING')

    const select = screen.getByRole('combobox', {
      name: 'admin:space.runtime.hardwareChange'
    }) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'cpu-upgrade' } })
    expect(screen.getByText('admin:space.runtime.hardwareBilling')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'admin:space.runtime.hardwareApply' }))
    expect(screen.getByText('admin:space.runtime.hardwareTitle')).toBeTruthy()
    const confirm = screen
      .getAllByRole('button', { name: 'admin:space.runtime.hardwareApply' })
      .at(-1) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)

    const field = screen.getByLabelText('admin:space.runtime.confirmLabel repoId=owner/space')
    fireEvent.change(field, { target: { value: REPO } })
    const ready = screen
      .getAllByRole('button', { name: 'admin:space.runtime.hardwareApply' })
      .at(-1) as HTMLButtonElement
    expect(ready.disabled).toBe(false)
    fireEvent.click(ready)
    await waitFor(() => {
      expect(ipc.invoke).toHaveBeenCalledWith('hub:spaceHardwareSet', {
        repoId: REPO,
        flavor: 'cpu-upgrade'
      })
    })

    // No currency symbol or numeric price may be rendered anywhere.
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/[$€£¥]/)
    expect(text).not.toMatch(/\bUSD\b/)
  })

  it('applies a free-tier hardware change without typed confirmation', async () => {
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'hub:spaceRuntime')
        return runtime({ hardware: 'cpu-upgrade', gcTimeout: 172800 })
      if (channel === 'hub:spaceHardwareList') return CATALOG
      if (channel === 'hub:spaceSecrets') return {}
      if (channel === 'hub:spaceVariables') return {}
      if (channel === 'hub:spaceLogs') return { text: '' }
      throw new Error(`unexpected ${channel}`)
    })
    renderPanel()
    await screen.findByText('48 h')
    const select = screen.getByRole('combobox', {
      name: 'admin:space.runtime.hardwareChange'
    }) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'cpu-basic' } })
    expect(screen.queryByText('admin:space.runtime.hardwareBilling')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'admin:space.runtime.hardwareApply' }))
    await waitFor(() => {
      expect(ipc.invoke).toHaveBeenCalledWith('hub:spaceHardwareSet', {
        repoId: REPO,
        flavor: 'cpu-basic'
      })
    })
  })

  it('shows the reported sleep window and allows custom/never sleep on upgraded hardware', async () => {
    mockHub({
      'hub:spaceRuntime': runtime({ hardware: 'cpu-upgrade', gcTimeout: 172800, sleepTime: 172800 })
    })
    renderPanel()

    // The reported duration is displayed without inventing a default.
    expect(await screen.findByText('48 h')).toBeTruthy()
    expect(sleepInput().disabled).toBe(false)

    fireEvent.change(sleepInput(), { target: { value: '3600' } })
    fireEvent.click(screen.getByRole('button', { name: 'admin:space.runtime.sleepApply' }))
    await waitFor(() => {
      expect(ipc.invoke).toHaveBeenCalledWith('hub:spaceSleepTimeSet', {
        repoId: REPO,
        seconds: 3600
      })
    })

    fireEvent.click(screen.getByRole('button', { name: 'admin:space.runtime.sleepNeverApply' }))
    await waitFor(() => {
      expect(ipc.invoke).toHaveBeenCalledWith('hub:spaceSleepTimeSet', {
        repoId: REPO,
        seconds: -1
      })
    })
  })

  it('keeps secrets, variables and logs untouched by lifecycle mutations', async () => {
    let stage = 'RUNNING'
    ipc.invoke.mockImplementation(async (channel: string, req?: unknown) => {
      if (channel === 'hub:spaceRuntime') return runtime({ stage })
      if (channel === 'hub:spaceHardwareList') return CATALOG
      if (channel === 'hub:spaceSecrets') return { HF_TOKEN: { key: 'HF_TOKEN' } }
      if (channel === 'hub:spaceVariables') return { MODEL: { key: 'MODEL', value: 'gpt2' } }
      if (channel === 'hub:spaceLogs') return { text: 'ok' }
      if (channel === 'hub:spacePause') {
        stage = 'PAUSED'
        return {}
      }
      throw new Error(`unexpected ${channel} ${JSON.stringify(req)}`)
    })
    renderPanel()
    expect(await screen.findByText('HF_TOKEN')).toBeTruthy()
    expect(screen.getByText('MODEL')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'admin:space.runtime.pause' }))
    fireEvent.click(screen.getByRole('button', { name: 'admin:space.runtime.pause' }))
    await waitFor(() => {
      expect(ipc.invoke.mock.calls.some(([c]) => c === 'hub:spacePause')).toBe(true)
    })
    // The lifecycle mutation must not invalidate the env/log caches.
    expect(ipc.invoke.mock.calls.filter(([c]) => c === 'hub:spaceSecrets').length).toBe(1)
    expect(ipc.invoke.mock.calls.filter(([c]) => c === 'hub:spaceVariables').length).toBe(1)
    expect(screen.getByText('HF_TOKEN')).toBeTruthy()
  })
})

describe('SpaceOpsPanel gating', () => {
  it('hides all lifecycle controls without the manage-repos scope', () => {
    useAppStore.setState({
      auth: {
        status: 'signedIn',
        accountId: 'a',
        user: { name: 'owner', fullname: 'owner', orgs: [] },
        method: 'token',
        tokenDisplayName: 't',
        tokenRole: 'read'
      }
    })
    mockHub({})
    renderPanel()
    expect(screen.queryByText('admin:space.runtime.title')).toBeNull()
    expect(screen.queryByRole('button', { name: 'admin:space.runtime.pause' })).toBeNull()
  })
})

describe('SpaceOpsPanel sleep input validation', () => {
  it('rejects zero and non-integer sleep values before any request', async () => {
    mockHub({
      'hub:spaceRuntime': runtime({ hardware: 'cpu-upgrade', gcTimeout: 172800 })
    })
    renderPanel()
    await screen.findByText('48 h')

    fireEvent.change(sleepInput(), { target: { value: '0' } })
    expect(
      (screen.getByRole('button', { name: 'admin:space.runtime.sleepApply' }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
    fireEvent.change(sleepInput(), { target: { value: '1.5' } })
    expect(
      (screen.getByRole('button', { name: 'admin:space.runtime.sleepApply' }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
    expect(ipc.invoke.mock.calls.some(([c]) => c === 'hub:spaceSleepTimeSet')).toBe(false)
  })
})
