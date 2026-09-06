// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DownloadPlan } from '@hubfetch/shared'

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
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

import { DownloadCreateDialog } from './DownloadCreateDialog'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'

function makePlan(overrides: Partial<DownloadPlan> = {}): DownloadPlan {
  return {
    planId: 'plan-1',
    repoId: 'org/repo',
    kind: 'model',
    revision: 'main',
    resolvedCommit: COMMIT,
    endpoint: 'https://hub.example.test',
    proxy: { mode: 'system' },
    files: [
      { path: 'weights.bin', size: 1000, alreadyCached: false, coveredByLiveTask: false },
      { path: 'config.json', size: 200, alreadyCached: true, coveredByLiveTask: false },
      { path: 'vocab.txt', size: 50, alreadyCached: false, coveredByLiveTask: true }
    ],
    totalBytes: 1250,
    totalFiles: 3,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    digest: 'test-digest',
    ...overrides
  }
}

function renderDialog(
  plan: DownloadPlan | null,
  onConfirm: (paths: string[]) => void,
  opts?: { loading?: boolean; error?: string; pending?: boolean }
): void {
  render(
    <DownloadCreateDialog
      open
      plan={plan}
      loading={opts?.loading ?? false}
      error={opts?.error}
      pending={opts?.pending ?? false}
      onConfirm={onConfirm}
      onOpenChange={vi.fn()}
    />
  )
}

function startButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /downloads:create.start/ })
}

afterEach(() => {
  cleanup()
})

describe('DownloadCreateDialog plan review', () => {
  it('shows loading state when resolving', () => {
    renderDialog(null, vi.fn(), { loading: true })
    expect(screen.getByText('downloads:create.resolving')).toBeTruthy()
    expect(startButton().disabled).toBe(true)
  })

  it('shows error state with retry button', () => {
    const onRetry = vi.fn()
    render(
      <DownloadCreateDialog
        open
        plan={null}
        loading={false}
        error="Hub did not resolve"
        onRetry={onRetry}
        pending={false}
        onConfirm={vi.fn()}
        onOpenChange={vi.fn()}
      />
    )
    expect(screen.getByText('Hub did not resolve')).toBeTruthy()
    fireEvent.click(screen.getByText('downloads:create.retry'))
    expect(onRetry).toHaveBeenCalled()
  })

  it('shows file list with checkboxes and summary', () => {
    const plan = makePlan()
    renderDialog(plan, vi.fn())

    // Summary bar shows file count and total size.
    expect(screen.getByText(/downloads:create.files/)).toBeTruthy()
    expect(screen.getByText(/downloads:create.totalSize/)).toBeTruthy()

    // All three files are rendered.
    expect(screen.getByText('weights.bin')).toBeTruthy()
    expect(screen.getByText('config.json')).toBeTruthy()
    expect(screen.getByText('vocab.txt')).toBeTruthy()

    // Cached and covered labels.
    expect(screen.getByText('downloads:create.cached')).toBeTruthy()
    expect(screen.getByText('downloads:create.covered')).toBeTruthy()

    // All files selected by default.
    expect(startButton().disabled).toBe(false)
  })

  it('select all / none buttons work', () => {
    const plan = makePlan()
    const onConfirm = vi.fn()
    renderDialog(plan, onConfirm)

    // Deselect all.
    fireEvent.click(screen.getByText('downloads:create.selectNone'))
    expect(startButton().disabled).toBe(true)

    // Select all.
    fireEvent.click(screen.getByText('downloads:create.selectAll'))
    expect(startButton().disabled).toBe(false)

    // Confirm with all paths.
    fireEvent.click(startButton())
    expect(onConfirm).toHaveBeenCalledWith(['weights.bin', 'config.json', 'vocab.txt'])
  })

  it('filters files by search', () => {
    const plan = makePlan()
    renderDialog(plan, vi.fn())

    const searchInput = screen.getByRole('searchbox')
    fireEvent.change(searchInput, { target: { value: 'config' } })

    expect(screen.queryByText('weights.bin')).toBeNull()
    expect(screen.getByText('config.json')).toBeTruthy()
    expect(screen.queryByText('vocab.txt')).toBeNull()
  })

  it('disables confirm when pending', () => {
    const plan = makePlan()
    renderDialog(plan, vi.fn(), { pending: true })
    expect(startButton().disabled).toBe(true)
  })

  it('shows proxy summary in system mode', () => {
    const plan = makePlan({ proxy: { mode: 'system' } })
    renderDialog(plan, vi.fn())
    expect(screen.getByText('downloads:create.proxySystem')).toBeTruthy()
  })

  it('shows proxy summary in manual mode', () => {
    const plan = makePlan({ proxy: { mode: 'manual', url: 'http://127.0.0.1:7897' } })
    renderDialog(plan, vi.fn())
    expect(screen.getByText(/downloads:create.proxyManual/)).toBeTruthy()
  })

  it('shows account label when present', () => {
    const plan = makePlan({ accountId: 'acct-1', accountLabel: 'my-token' })
    renderDialog(plan, vi.fn())
    expect(screen.getByText(/downloads:create.account/)).toBeTruthy()
  })
})