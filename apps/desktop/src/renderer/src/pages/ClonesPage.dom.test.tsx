// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloneRecord, DiagnosticReport } from '@hubfetch/shared'

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
  // Radix Dialog/FocusScope needs a couple of browser APIs jsdom lacks.
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => undefined
  }
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) }
  })
})

const lib = vi.hoisted(() => ({
  listClones: vi.fn(),
  cancelClone: vi.fn(),
  retryClone: vi.fn(),
  removeClone: vi.fn(),
  openCloneDestination: vi.fn(),
  onClonesChanged: vi.fn()
}))
const diagnostics = vi.hoisted(() => ({ runDiagnostics: vi.fn() }))
const router = vi.hoisted(() => ({ navigate: vi.fn(), search: '' }))

vi.mock('@/lib/clones', () => lib)
vi.mock('@/lib/diagnostics', () => diagnostics)
vi.mock('react-router', () => ({
  useNavigate: () => router.navigate,
  useLocation: () => ({ search: router.search })
}))
vi.mock('react-i18next', () => {
  const TEMPLATES: Record<string, string> = {
    'clones:queuePosition': 'Queue #{{n}}',
    'clones:attempt': 'Attempt {{n}}',
    'clones:detail.retryOfAttempt': 'Retry of attempt {{id}}',
    'clones:detail.updated': 'Updated {{time}}',
    'clones:progress.percent': '{{percent}}%',
    'clones:progress.counters': '{{done}}/{{total}}',
    'clones:progress.summary': '{{phase}} · {{percent}} · {{counters}}',
    'clones:action.viewDetails': 'Details for {{id}}'
  }
  return {
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) => {
        const template = TEMPLATES[key] ?? key
        if (!opts) return template
        let out = template
        for (const [name, value] of Object.entries(opts)) {
          out = out.replace(`{{${name}}}`, String(value))
        }
        return out
      },
      i18n: { language: 'en' }
    })
  }
})

import { ClonesPage } from './ClonesPage'
import { Toaster, useToasts } from '@/components/ui/toaster'
import { TooltipProvider } from '@/components/ui/tooltip'

const RUNNING_ID = '11111111-1111-4111-8111-111111111111'
const QUEUED_ID = '22222222-2222-4222-8222-222222222222'
const COMPLETED_ID = '33333333-3333-4333-8333-333333333333'
const FAILED_ID = '44444444-4444-4444-8444-444444444444'
const CANCELLED_ID = '55555555-5555-4555-8555-555555555555'
const INTERRUPTED_ID = '66666666-6666-4666-8666-666666666666'
const CANCELLING_ID = '77777777-7777-4777-8777-777777777777'

function clone(overrides: Partial<CloneRecord> & { id: string }): CloneRecord {
  return {
    attempt: 1,
    repoKind: 'model',
    repoId: `acme/${overrides.id.slice(0, 8)}`,
    revision: { kind: 'branch', name: 'main' },
    transport: 'https',
    destination: `E:\\Repos\\${overrides.id.slice(0, 8)}`,
    auth: 'system',
    proxy: { mode: 'system' },
    status: 'queued',
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
    ...overrides
  }
}

function diagnosticReport(): DiagnosticReport {
  const checkedAt = '2026-08-17T00:00:00.000Z'
  return {
    completedAt: checkedAt,
    checks: [
      {
        id: 'git.version',
        category: 'git',
        status: 'pass',
        reasonCode: 'ok',
        message: 'Git is installed',
        durationMs: 1,
        checkedAt
      },
      {
        id: 'git.xet',
        category: 'git',
        status: 'warning',
        reasonCode: 'missing',
        message: 'Git-Xet is not installed',
        durationMs: 1,
        checkedAt
      },
      {
        id: 'git.gcm',
        category: 'credentials',
        status: 'pass',
        reasonCode: 'ok',
        message: 'Git Credential Manager is available',
        durationMs: 1,
        checkedAt
      },
      {
        id: 'git.ssh',
        category: 'credentials',
        status: 'pass',
        reasonCode: 'ok',
        message: 'SSH is available',
        durationMs: 1,
        checkedAt
      }
    ]
  }
}

const allStatuses = [
  clone({
    id: RUNNING_ID,
    status: 'running',
    progress: { phase: 'receiving', percent: 42, done: 1200, total: 3000 }
  }),
  clone({ id: QUEUED_ID, status: 'queued' }),
  clone({ id: COMPLETED_ID, status: 'completed' }),
  clone({ id: FAILED_ID, status: 'failed', error: 'clone failed: 401 Unauthorized' }),
  clone({ id: CANCELLED_ID, status: 'cancelled' }),
  clone({ id: INTERRUPTED_ID, status: 'interrupted' }),
  clone({ id: CANCELLING_ID, status: 'cancelling' })
]

let pushedListener: ((records: CloneRecord[]) => void) | undefined

function renderPage(records: CloneRecord[] = allStatuses, search = ''): void {
  router.search = search
  lib.listClones.mockResolvedValue(records)
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  render(
    <TooltipProvider delayDuration={0}>
      <QueryClientProvider client={client}>
        <ClonesPage />
        <Toaster />
      </QueryClientProvider>
    </TooltipProvider>
  )
}

async function waitForQueue(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: /queue\.title/ })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /action\.copyDetails/ }).length).toBeGreaterThan(0)
  })
}

afterEach(() => {
  cleanup()
  useToasts.setState({ toasts: [] })
  router.navigate.mockReset()
  lib.listClones.mockReset()
  lib.cancelClone.mockReset()
  lib.retryClone.mockReset()
  lib.removeClone.mockReset()
  lib.openCloneDestination.mockReset()
  lib.onClonesChanged.mockReset()
  diagnostics.runDiagnostics.mockReset()
})

beforeEach(() => {
  pushedListener = undefined
  diagnostics.runDiagnostics.mockResolvedValue(diagnosticReport())
  lib.cancelClone.mockResolvedValue(allStatuses)
  lib.removeClone.mockResolvedValue(allStatuses)
  lib.retryClone.mockImplementation((_parentId: string, request: { destination: string }) =>
    Promise.resolve(
      clone({
        id: '99999999-9999-4999-8999-999999999999',
        status: 'queued',
        attempt: 2,
        destination: request.destination
      })
    )
  )
  lib.openCloneDestination.mockResolvedValue(undefined)
  lib.onClonesChanged.mockImplementation((fn: (records: CloneRecord[]) => void) => {
    pushedListener = fn
    return () => undefined
  })
})

describe('ClonesPage', () => {
  it('renders the queue with every status and a status-filter group', async () => {
    renderPage()
    await waitForQueue()
    expect(screen.getAllByText('clones:status.running').length).toBeGreaterThan(0)
    expect(screen.getAllByText('clones:status.queued').length).toBeGreaterThan(0)
    expect(screen.getAllByText('clones:status.completed').length).toBeGreaterThan(0)
    expect(screen.getAllByText('clones:status.failed').length).toBeGreaterThan(0)
    expect(screen.getAllByText('clones:status.interrupted').length).toBeGreaterThan(0)
    expect(screen.getByRole('group', { name: 'clones:filter.label' })).toBeTruthy()
  })

  it('shows normalized phase/percent/counters for a running attempt', async () => {
    renderPage()
    await waitForQueue()
    const card = within(screen.getByTestId(`clone-card-${RUNNING_ID}`))
    expect(card.getByText(/clones:phase\.receiving/)).toBeTruthy()
    expect(card.getByText(/42%/)).toBeTruthy()
    expect(card.getByText(/1200\/3000/)).toBeTruthy()
    expect(card.getByRole('progressbar')).toBeTruthy()
  })

  it('derives FIFO queue positions for non-terminal attempts', async () => {
    renderPage([
      clone({ id: RUNNING_ID, status: 'running' }),
      clone({ id: QUEUED_ID, status: 'queued' }),
      clone({ id: COMPLETED_ID, status: 'completed' })
    ])
    await waitForQueue()
    const runningCard = within(screen.getByTestId(`clone-card-${RUNNING_ID}`))
    expect(runningCard.getByText('Queue #1')).toBeTruthy()
    const queuedCard = within(screen.getByTestId(`clone-card-${QUEUED_ID}`))
    expect(queuedCard.getByText('Queue #2')).toBeTruthy()
    const completedCard = within(screen.getByTestId(`clone-card-${COMPLETED_ID}`))
    expect(completedCard.queryByText(/Queue #/)).toBeNull()
  })

  it('filters the list by status chip', async () => {
    renderPage()
    await waitForQueue()
    fireEvent.click(screen.getByRole('button', { name: /clones:status\.failed/ }))
    expect(screen.getByText('acme/44444444')).toBeTruthy()
    expect(screen.queryByText('acme/11111111')).toBeNull()
    expect(screen.queryByText('acme/22222222')).toBeNull()
  })

  it('cancels a queued attempt after confirmation', async () => {
    renderPage()
    await waitForQueue()
    const card = within(screen.getByTestId(`clone-card-${QUEUED_ID}`))
    fireEvent.click(card.getByLabelText('clones:action.cancel'))
    expect(screen.getByText('clones:action.cancelConfirmTitle')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'clones:action.cancelConfirmConfirm' }))
    await waitFor(() => expect(lib.cancelClone).toHaveBeenCalledWith(QUEUED_ID))
  })

  it('never offers cancel on terminal attempts', async () => {
    renderPage()
    await waitForQueue()
    for (const id of [COMPLETED_ID, FAILED_ID, CANCELLED_ID, INTERRUPTED_ID]) {
      const card = within(screen.getByTestId(`clone-card-${id}`))
      expect(card.queryByLabelText('clones:action.cancel')).toBeNull()
    }
  })

  it('disables cancel with a reason while a cancellation is already in flight', async () => {
    renderPage()
    await waitForQueue()
    const card = within(screen.getByTestId(`clone-card-${CANCELLING_ID}`))
    const cancel = card.getByLabelText('clones:action.cancel') as HTMLButtonElement
    expect(cancel.disabled).toBe(true)
  })

  it('opens the completed and interrupted destination folders', async () => {
    renderPage()
    await waitForQueue()
    const completed = within(screen.getByTestId(`clone-card-${COMPLETED_ID}`))
    fireEvent.click(completed.getByLabelText('clones:action.openFolder'))
    await waitFor(() => expect(lib.openCloneDestination).toHaveBeenCalledWith(COMPLETED_ID))

    const interrupted = within(screen.getByTestId(`clone-card-${INTERRUPTED_ID}`))
    fireEvent.click(interrupted.getByLabelText('clones:action.openFolder'))
    await waitFor(() => expect(lib.openCloneDestination).toHaveBeenLastCalledWith(INTERRUPTED_ID))
  })

  it('refuses an in-place retry (same destination) with a localized reason', async () => {
    renderPage()
    await waitForQueue()
    const card = within(screen.getByTestId(`clone-card-${FAILED_ID}`))
    fireEvent.click(card.getByLabelText('clones:action.retry'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('clones:action.retryDestinationLabel'), {
      target: { value: 'E:\\Repos\\44444444' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'clones:action.retryStart' }))
    expect(within(dialog).getByText('clones:action.retryError.same')).toBeTruthy()
    expect(lib.retryClone).not.toHaveBeenCalled()
  })

  it('retries a failed attempt into a NEW empty destination with the frozen attempt config', async () => {
    renderPage()
    await waitForQueue()
    const card = within(screen.getByTestId(`clone-card-${FAILED_ID}`))
    fireEvent.click(card.getByLabelText('clones:action.retry'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('clones:action.retryDestinationLabel'), {
      target: { value: 'E:\\Repos\\retry-44444444' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'clones:action.retryStart' }))
    await waitFor(() => expect(lib.retryClone).toHaveBeenCalledTimes(1))
    const [parentId, request] = lib.retryClone.mock.calls[0] as [string, Record<string, unknown>]
    expect(parentId).toBe(FAILED_ID)
    expect(request).toMatchObject({
      kind: 'model',
      id: 'acme/44444444',
      transport: 'https',
      destination: 'E:\\Repos\\retry-44444444',
      auth: 'system',
      proxy: { mode: 'system' }
    })
  })

  it('never offers retry while an attempt is queued or running', async () => {
    renderPage()
    await waitForQueue()
    for (const id of [QUEUED_ID, RUNNING_ID, CANCELLING_ID, COMPLETED_ID]) {
      const card = within(screen.getByTestId(`clone-card-${id}`))
      expect(card.queryByLabelText('clones:action.retry')).toBeNull()
    }
  })

  it('copies sanitized details without leaking token or credential URL', async () => {
    const leaky = clone({
      id: FAILED_ID,
      status: 'failed',
      error: 'auth failed for https://user:hf_AbCdEf123456@huggingface.co/acme/x'
    })
    renderPage([leaky])
    await waitForQueue()
    const card = within(screen.getByTestId(`clone-card-${FAILED_ID}`))
    fireEvent.click(card.getByLabelText('clones:action.copyDetails'))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1))
    const copied =
      (
        navigator.clipboard.writeText as unknown as {
          mock: { calls: Array<[string]> }
        }
      ).mock.calls[0]?.[0] ?? ''
    expect(copied).not.toContain('hf_AbCdEf123456')
    expect(copied).not.toContain('https://user:')
    expect(copied).toContain('<redacted>')
  })

  it('links a retry attempt back to its parent via ?selected navigation', async () => {
    const parent = clone({ id: FAILED_ID, status: 'failed' })
    const child = clone({
      id: RUNNING_ID,
      status: 'queued',
      attempt: 2,
      retryOf: FAILED_ID,
      destination: 'E:\\Repos\\retry-44444444'
    })
    renderPage([parent, child])
    await waitForQueue()
    const childCard = within(screen.getByTestId(`clone-card-${RUNNING_ID}`))
    fireEvent.click(childCard.getByText('Retry of attempt 1'))
    expect(router.navigate).toHaveBeenCalledWith(
      `/clones?selected=${encodeURIComponent(FAILED_ID)}`
    )
  })

  it('opens the detail drawer from a row click via ?selected navigation', async () => {
    renderPage()
    await waitForQueue()
    const card = within(screen.getByTestId(`clone-card-${QUEUED_ID}`))
    fireEvent.click(card.getByLabelText('Details for acme/22222222'))
    expect(router.navigate).toHaveBeenCalledWith(
      `/clones?selected=${encodeURIComponent(QUEUED_ID)}`
    )
  })

  it('applies authoritative push events to the visible queue', async () => {
    renderPage()
    await waitForQueue()
    act(() => pushedListener?.([]))
    await waitFor(() => {
      expect(screen.getByText('clones:queue.emptyTitle')).toBeTruthy()
    })
  })

  it('opens the detail drawer for ?selected= with full sanitized fields', async () => {
    renderPage(allStatuses, `?selected=${RUNNING_ID}`)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('clones:detail.repository')).toBeTruthy()
    expect(within(dialog).getByText('clones:detail.destination')).toBeTruthy()
    expect(within(dialog).getByText('clones:detail.progress')).toBeTruthy()
    expect(diagnostics.runDiagnostics).toHaveBeenCalled()
  })

  it('distinguishes interrupted from failed/cancelled in the detail drawer', async () => {
    renderPage(allStatuses, `?selected=${INTERRUPTED_ID}`)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('clones:banner.interrupted')).toBeTruthy()
    expect(within(dialog).getAllByText('clones:status.interrupted').length).toBeGreaterThan(0)
    expect(within(dialog).getByText('clones:detail.retryInfoBody')).toBeTruthy()
  })

  it('keeps every row control keyboard-visible with an accessible label', async () => {
    renderPage()
    await waitForQueue()
    expect(screen.getAllByLabelText(/Details for /).length).toBe(allStatuses.length)
    expect(screen.getAllByLabelText('clones:action.copyDetails').length).toBe(allStatuses.length)
    const chips = screen.getByRole('group', { name: 'clones:filter.label' })
    expect(
      within(chips)
        .getByRole('button', { name: /clones:filter\.all/ })
        .getAttribute('aria-pressed')
    ).toBe('true')
  })

  it('shows remove on terminal cards and never on queued, running, or cancelling', async () => {
    renderPage()
    await waitForQueue()
    for (const id of [COMPLETED_ID, FAILED_ID, CANCELLED_ID, INTERRUPTED_ID]) {
      const card = within(screen.getByTestId(`clone-card-${id}`))
      expect(card.getByLabelText('clones:action.remove')).toBeTruthy()
    }
    for (const id of [QUEUED_ID, RUNNING_ID, CANCELLING_ID]) {
      const card = within(screen.getByTestId(`clone-card-${id}`))
      expect(card.queryByLabelText('clones:action.remove')).toBeNull()
    }
  })

  it('shows remove in the detail drawer only for terminal records', async () => {
    const cases: ReadonlyArray<{ id: string; shown: boolean }> = [
      { id: COMPLETED_ID, shown: true },
      { id: FAILED_ID, shown: true },
      { id: CANCELLED_ID, shown: true },
      { id: INTERRUPTED_ID, shown: true },
      { id: QUEUED_ID, shown: false },
      { id: RUNNING_ID, shown: false },
      { id: CANCELLING_ID, shown: false }
    ]
    for (const { id, shown } of cases) {
      cleanup()
      renderPage(allStatuses, `?selected=${id}`)
      const dialog = await screen.findByRole('dialog')
      const remove = within(dialog).queryByRole('button', { name: 'clones:action.remove' })
      if (shown) {
        expect(remove).toBeTruthy()
      } else {
        expect(remove).toBeNull()
      }
    }
  })

  it('confirms removal from the returned list, toasts success, and does not navigate when unselected', async () => {
    const remaining = [clone({ id: QUEUED_ID, status: 'queued' })]
    lib.removeClone.mockResolvedValue(remaining)
    renderPage()
    await waitForQueue()
    const card = within(screen.getByTestId(`clone-card-${COMPLETED_ID}`))
    fireEvent.click(card.getByLabelText('clones:action.remove'))
    expect(screen.getByText('clones:action.removeConfirmTitle')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'clones:action.removeConfirmConfirm' }))
    await waitFor(() => expect(lib.removeClone).toHaveBeenCalledTimes(1))
    expect(lib.removeClone).toHaveBeenCalledWith(COMPLETED_ID)
    await waitFor(() => {
      expect(screen.queryByTestId(`clone-card-${COMPLETED_ID}`)).toBeNull()
      expect(screen.queryByTestId(`clone-card-${FAILED_ID}`)).toBeNull()
    })
    expect(screen.getByTestId(`clone-card-${QUEUED_ID}`)).toBeTruthy()
    expect(screen.getByText('clones:action.removeSuccess')).toBeTruthy()
    expect(router.navigate).not.toHaveBeenCalled()
  })

  it('navigates to /clones when the selected drawer record is removed', async () => {
    lib.removeClone.mockResolvedValue(allStatuses.filter((record) => record.id !== COMPLETED_ID))
    renderPage(allStatuses, `?selected=${COMPLETED_ID}`)
    const drawer = await screen.findByRole('dialog')
    fireEvent.click(within(drawer).getByRole('button', { name: 'clones:action.remove' }))
    fireEvent.click(screen.getByRole('button', { name: 'clones:action.removeConfirmConfirm' }))
    await waitFor(() => expect(lib.removeClone).toHaveBeenCalledTimes(1))
    expect(lib.removeClone).toHaveBeenCalledWith(COMPLETED_ID)
    await waitFor(() => expect(screen.queryByTestId(`clone-card-${COMPLETED_ID}`)).toBeNull())
    expect(router.navigate).toHaveBeenCalledWith('/clones')
    expect(screen.getByText('clones:action.removeSuccess')).toBeTruthy()
  })

  it('makes no remove call when confirmation is cancelled', async () => {
    renderPage()
    await waitForQueue()
    const card = within(screen.getByTestId(`clone-card-${FAILED_ID}`))
    fireEvent.click(card.getByLabelText('clones:action.remove'))
    expect(screen.getByText('clones:action.removeConfirmTitle')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'common:cancel' }))
    expect(lib.removeClone).not.toHaveBeenCalled()
    expect(screen.queryByText('clones:action.removeConfirmTitle')).toBeNull()
    expect(screen.getByTestId(`clone-card-${FAILED_ID}`)).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('leaves the record, drawer, and toast/navigation intact when removal is rejected', async () => {
    lib.removeClone.mockRejectedValue(new Error('cannot remove an active clone record'))
    renderPage(allStatuses, `?selected=${COMPLETED_ID}`)
    const drawer = await screen.findByRole('dialog')
    fireEvent.click(within(drawer).getByRole('button', { name: 'clones:action.remove' }))
    fireEvent.click(screen.getByRole('button', { name: 'clones:action.removeConfirmConfirm' }))
    await waitFor(() => expect(lib.removeClone).toHaveBeenCalledTimes(1))
    expect(lib.removeClone).toHaveBeenCalledWith(COMPLETED_ID)
    expect(screen.getByTestId(`clone-card-${COMPLETED_ID}`)).toBeTruthy()
    expect(screen.getByText('clones:detail.repository')).toBeTruthy()
    expect(screen.queryByText('clones:action.removeSuccess')).toBeNull()
    expect(router.navigate).not.toHaveBeenCalled()
  })
})
