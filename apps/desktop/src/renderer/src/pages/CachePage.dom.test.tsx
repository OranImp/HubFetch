// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CacheActionPlan,
  CacheActionResult,
  CachedRepo,
  CacheReport,
  CacheVerificationProgress,
  CacheVerificationReport,
  DownloadTask
} from '@hubfetch/shared'
import { DEFAULT_SETTINGS } from '@hubfetch/shared'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster, useToasts } from '@/components/ui/toaster'
import { useAppStore } from '@/stores/app'

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
  invoke: vi.fn<(channel: string, req?: unknown) => Promise<unknown>>(),
  on: vi.fn<(channel: string, listener: (payload: unknown) => void) => () => void>()
}))

vi.mock('@/lib/ipc', () => ({
  invoke: ipc.invoke,
  onIpcEvent: ipc.on,
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
    },
    i18n: { language: 'en' }
  })
}))

import { CachePage } from './CachePage'

const COMMIT = 'a'.repeat(40)
const BLOB = 'b'.repeat(64)
const PLAN_ID = '11111111-1111-4111-8111-111111111111'

function repo(): CachedRepo {
  return {
    id: 'org/name',
    kind: 'model',
    sizeOnDisk: 100,
    revisions: [
      { commitHash: COMMIT, sizeOnDisk: 100, fileCount: 1, refs: ['main'] }
    ],
    partialSize: 12
  }
}

function scanReport(repos: CachedRepo[] = [repo()]): CacheReport {
  return { root: '/cache', totalSize: 100, repos, scannedAt: '2026-09-05T00:00:00.000Z' }
}

function verifyReport(
  issues: CacheVerificationReport['repos'][0]['issues']
): CacheVerificationReport {
  return {
    root: '/cache',
    ok: issues.length === 0,
    repos: [
      {
        id: 'org/name',
        kind: 'model',
        ok: issues.length === 0,
        verifiedBlobs: issues.length === 0 ? 2 : 1,
        verifiedBytes: 40,
        issues,
        partialFiles: 0,
        partialBytes: 0
      }
    ],
    totalVerifiedBlobs: issues.length === 0 ? 2 : 1,
    totalVerifiedBytes: 40,
    totalIssues: issues.length,
    totalPartialFiles: 0,
    totalPartialBytes: 0,
    truncated: false,
    scannedAt: '2026-09-05T01:00:00.000Z'
  }
}

function prunePlan(): CacheActionPlan {
  return {
    action: 'prune',
    planId: PLAN_ID,
    kind: 'model',
    repoId: 'org/name',
    scannedAt: '2026-09-05T00:00:00.000Z',
    createdAt: '2026-09-05T00:00:00.000Z',
    expiresAt: '2026-09-05T00:15:00.000Z',
    protectedCommits: [COMMIT],
    protectedTaskIds: ['task-1'],
    digest: 'd'.repeat(64),
    entries: [
      { kind: 'orphan-blob', path: `models--org--name/blobs/${BLOB}`, name: BLOB, estimatedBytes: 40 }
    ],
    estimatedBytes: 40
  }
}

function repairPlan(): CacheActionPlan {
  return {
    action: 'repair',
    planId: PLAN_ID,
    kind: 'model',
    repoId: 'org/name',
    scannedAt: '2026-09-05T00:00:00.000Z',
    createdAt: '2026-09-05T00:00:00.000Z',
    expiresAt: '2026-09-05T00:15:00.000Z',
    resolvedCommit: COMMIT,
    endpoint: 'https://huggingface.co',
    proxy: { mode: 'system' },
    accountLabel: 'ada',
    protectedCommits: [],
    protectedTaskIds: [],
    digest: 'e'.repeat(64),
    entries: [
      {
        issue: 'hash-mismatch',
        path: `models--org--name/blobs/${BLOB}`,
        repoPath: 'config.json',
        estimatedBytes: 40
      }
    ],
    estimatedBytes: 40
  }
}

let progressListener: ((payload: CacheVerificationProgress) => void) | undefined

function renderPage(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  render(
    <TooltipProvider>
      <QueryClientProvider client={client}>
        <CachePage />
        <Toaster />
      </QueryClientProvider>
    </TooltipProvider>
  )
  return client
}

afterEach(() => {
  cleanup()
  useToasts.setState({ toasts: [] })
  ipc.invoke.mockReset()
  ipc.on.mockReset()
  useAppStore.setState({
    settings: DEFAULT_SETTINGS,
    appInfo: null,
    auth: { status: 'signedOut' }
  })
})

beforeEach(() => {
  progressListener = undefined
  ipc.on.mockImplementation((channel, listener) => {
    if (channel === 'evt:cacheVerification') progressListener = listener
    return () => undefined
  })
  ipc.invoke.mockImplementation(async (channel) => {
    if (channel === 'cache:scan') return scanReport()
    if (channel === 'downloads:list') return [] as DownloadTask[]
    if (channel === 'cache:verify') return verifyReport([])
    if (channel === 'cache:verifyCancel') return undefined
    if (channel === 'cache:planAction') return prunePlan()
    if (channel === 'cache:applyAction') {
      return {
        ok: true,
        action: 'prune',
        planId: PLAN_ID,
        bytes: 40,
        changed: 1
      } satisfies CacheActionResult
    }
    if (channel === 'cache:cleanPartials') return scanReport([{ ...repo(), partialSize: 0 }])
    if (channel === 'cache:deleteRevisions') return scanReport([])
    if (channel === 'cache:revealRepo') return undefined
    throw new Error(`unexpected channel ${channel}`)
  })
})

describe('CachePage verification and plans', () => {
  it('shows a clean verification report with bounded counts', async () => {
    renderPage()
    await screen.findByText('org/name')
    fireEvent.click(screen.getByTestId('cache-verify'))
    await waitFor(() => {
      expect(screen.getByTestId('cache-verify-clean')).toBeTruthy()
    })
    const counts = screen.getByTestId('cache-verification-counts')
    expect(counts.children).toHaveLength(3)
    expect(ipc.invoke).toHaveBeenCalledWith('cache:verify', undefined)
  })

  it('lists relative corrupt and unreadable paths without implying Hub freshness', async () => {
    ipc.invoke.mockImplementation(async (channel) => {
      if (channel === 'cache:scan') return scanReport()
      if (channel === 'downloads:list') return []
      if (channel === 'cache:verify') {
        return verifyReport([
          { issue: 'hash-mismatch', path: `models--org--name/blobs/${BLOB}` },
          { issue: 'unreadable', path: 'models--org--name/snapshots/aa/file.bin' }
        ])
      }
      throw new Error(`unexpected channel ${channel}`)
    })
    renderPage()
    await screen.findByText('org/name')
    fireEvent.click(screen.getByTestId('cache-verify'))
    fireEvent.click(screen.getByText('org/name'))
    await waitFor(() => {
      expect(screen.getByText(`models--org--name/blobs/${BLOB}`)).toBeTruthy()
      expect(screen.getByText('models--org--name/snapshots/aa/file.bin')).toBeTruthy()
    })
    expect(screen.queryByText(/huggingface.co/)).toBeNull()
    expect(document.body.textContent).not.toContain('\\cache\\')
  })

  it('keeps progress in a reserved strip and can cancel', async () => {
    let release!: (report: CacheVerificationReport) => void
    ipc.invoke.mockImplementation(async (channel) => {
      if (channel === 'cache:scan') return scanReport()
      if (channel === 'downloads:list') return []
      if (channel === 'cache:verify') {
        return new Promise<CacheVerificationReport>((resolvePromise) => {
          release = resolvePromise
        })
      }
      if (channel === 'cache:verifyCancel') return undefined
      throw new Error(`unexpected channel ${channel}`)
    })
    renderPage()
    await screen.findByText('org/name')
    fireEvent.click(screen.getByTestId('cache-verify'))
    await waitFor(() => expect(screen.getByRole('progressbar')).toBeTruthy())
    act(() => {
      progressListener?.({
        phase: 'verifying',
        currentRepo: 'org/name',
        completedRepos: 1,
        totalRepos: 4,
        verifiedBlobs: 3,
        issuesFound: 0
      })
    })
    expect(screen.getByTestId('cache-verification-panel').className).toContain('min-h-[7.5rem]')
    fireEvent.click(screen.getByTestId('cache-verify-cancel'))
    expect(ipc.invoke).toHaveBeenCalledWith('cache:verifyCancel', undefined)
    release(verifyReport([]))
  })

  it('opens a prune preview with protected explanation and applies by plan id', async () => {
    renderPage()
    await screen.findByText('org/name')
    fireEvent.click(screen.getByTestId('cache-prune-model:org/name'))
    await screen.findByTestId('cache-plan-entries')
    expect(screen.getByText(`models--org--name/blobs/${BLOB}`)).toBeTruthy()
    expect(screen.getByText(/plan.protected/)).toBeTruthy()
    fireEvent.click(screen.getByTestId('cache-plan-apply'))
    await waitFor(() => {
      expect(ipc.invoke).toHaveBeenCalledWith('cache:applyAction', { request: { planId: PLAN_ID } })
    })
  })

  it('disables repair when signed out and enables prune offline', async () => {
    renderPage()
    await screen.findByText('org/name')
    expect((screen.getByTestId('cache-repair-model:org/name') as HTMLButtonElement).disabled).toBe(
      true
    )
    expect((screen.getByTestId('cache-prune-model:org/name') as HTMLButtonElement).disabled).toBe(
      false
    )
  })

  it('returns a stale apply to preview and requires replan', async () => {
    useAppStore.setState({
      auth: {
        status: 'signedIn',
        accountId: 'acct-1',
        user: { name: 'ada', orgs: [] },
        method: 'token'
      }
    })
    ipc.invoke.mockImplementation(async (channel) => {
      if (channel === 'cache:scan') return scanReport()
      if (channel === 'downloads:list') return []
      if (channel === 'cache:verify') {
        return verifyReport([{ issue: 'hash-mismatch', path: `models--org--name/blobs/${BLOB}` }])
      }
      if (channel === 'cache:planAction') return repairPlan()
      if (channel === 'cache:applyAction') {
        return {
          ok: false,
          action: 'repair',
          planId: PLAN_ID,
          bytes: 0,
          changed: 0,
          failure: { reason: 'plan-stale-filesystem', message: 'gone' }
        } satisfies CacheActionResult
      }
      throw new Error(`unexpected channel ${channel}`)
    })
    renderPage()
    await screen.findByText('org/name')
    fireEvent.click(screen.getByTestId('cache-verify'))
    await waitFor(() =>
      expect(
        (screen.getByTestId('cache-repair-model:org/name') as HTMLButtonElement).disabled
      ).toBe(false)
    )
    fireEvent.click(screen.getByTestId('cache-repair-model:org/name'))
    await screen.findByTestId('cache-plan-apply')
    fireEvent.click(screen.getByTestId('cache-plan-apply'))
    await screen.findByTestId('cache-plan-replan')
    expect(screen.getByTestId('cache-plan-entries')).toBeTruthy()
    fireEvent.click(screen.getByTestId('cache-plan-replan'))
    await waitFor(() => {
      expect(ipc.invoke.mock.calls.filter((call) => call[0] === 'cache:planAction').length).toBeGreaterThan(
        1
      )
    })
  })

  it('invalidates cache/download queries and re-verifies after a successful apply', async () => {
    const verifyCalls: string[] = []
    ipc.invoke.mockImplementation(async (channel) => {
      if (channel === 'cache:scan') return scanReport()
      if (channel === 'downloads:list') return []
      if (channel === 'cache:verify') {
        verifyCalls.push('verify')
        return verifyReport([])
      }
      if (channel === 'cache:planAction') return prunePlan()
      if (channel === 'cache:applyAction') {
        return {
          ok: true,
          action: 'prune',
          planId: PLAN_ID,
          bytes: 40,
          changed: 1
        } satisfies CacheActionResult
      }
      throw new Error(`unexpected channel ${channel}`)
    })
    renderPage()
    await screen.findByText('org/name')
    fireEvent.click(screen.getByTestId('cache-prune-model:org/name'))
    await screen.findByTestId('cache-plan-apply')
    fireEvent.click(screen.getByTestId('cache-plan-apply'))
    await waitFor(() => expect(verifyCalls.length).toBeGreaterThan(0))
  })

  it('keeps manual revision deletion and partial cleanup', async () => {
    renderPage()
    await screen.findByText('org/name')
    fireEvent.click(screen.getByText('org/name'))
    fireEvent.click(screen.getByLabelText('cache:deleteRevision'))
    expect(screen.getByText(/confirmDelete.title/)).toBeTruthy()
    fireEvent.click(screen.getByText('common:cancel'))
    fireEvent.click(screen.getByText('cache:cleanPartials'))
    await waitFor(() => {
      expect(ipc.invoke).toHaveBeenCalledWith('cache:cleanPartials', {
        kind: 'model',
        repoId: 'org/name'
      })
    })
  })

  it('keeps scan errors separate from verification errors', async () => {
    ipc.invoke.mockImplementation(async (channel) => {
      if (channel === 'cache:scan') throw new Error('EACCES scan failed')
      if (channel === 'downloads:list') return []
      throw new Error(`unexpected channel ${channel}`)
    })
    renderPage()
    await screen.findByTestId('cache-scan-error')
    expect(screen.getByText('EACCES scan failed')).toBeTruthy()
    expect(screen.queryByTestId('cache-verify-error')).toBeNull()
  })
})
