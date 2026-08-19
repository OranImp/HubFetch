// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiagnosticCheck, DiagnosticReport, DiagnosticStatus } from '@hubfetch/shared'

const diagnostics = vi.hoisted(() => ({ runDiagnostics: vi.fn() }))
const cloneTools = vi.hoisted(() => ({ performCloneToolInstall: vi.fn() }))

vi.mock('@/lib/diagnostics', () => diagnostics)
vi.mock('@/lib/clone-tools', () => cloneTools)
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

import { CloneToolsSection } from './CloneToolsSection'
import { useToasts } from '@/components/ui/toaster'

const CHECKED_AT = '2026-08-19T00:00:00.000Z'

function makeCheck(
  id: string,
  category: DiagnosticCheck['category'],
  status: DiagnosticStatus,
  message: string
): DiagnosticCheck {
  return {
    id,
    category,
    status,
    reasonCode: status === 'pass' ? 'ok' : 'missing',
    message,
    durationMs: 1,
    checkedAt: CHECKED_AT
  }
}

function makeReport(statuses: {
  git: DiagnosticStatus
  xet: DiagnosticStatus
  gcm: DiagnosticStatus
}): DiagnosticReport {
  return {
    completedAt: CHECKED_AT,
    checks: [
      makeCheck(
        'git.version',
        'git',
        statuses.git,
        statuses.git === 'pass' ? 'Git is installed' : 'Git is not installed'
      ),
      makeCheck(
        'git.xet',
        'git',
        statuses.xet,
        statuses.xet === 'pass' ? 'Git-Xet is ready' : 'Git-Xet is not installed'
      ),
      makeCheck(
        'git.gcm',
        'credentials',
        statuses.gcm,
        statuses.gcm === 'pass' ? 'GCM is available' : 'GCM is not available'
      )
    ]
  }
}

function renderSection(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  render(
    <QueryClientProvider client={client}>
      <CloneToolsSection />
    </QueryClientProvider>
  )
  return client
}

afterEach(() => {
  cleanup()
  diagnostics.runDiagnostics.mockReset()
  cloneTools.performCloneToolInstall.mockReset()
  useToasts.setState({ toasts: [] })
})

beforeEach(() => {
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true
  })
})

describe('CloneToolsSection', () => {
  it('shows the GCM install action when Git passes and GCM is missing', async () => {
    diagnostics.runDiagnostics.mockResolvedValue(makeReport({ git: 'pass', xet: 'pass', gcm: 'failure' }))
    renderSection()
    // Wait until the diagnostics report has landed so the row reflects real data.
    await screen.findByText('GCM is not available')
    const gcmRow = screen.getByTestId('clone-tool-row-gcm')
    expect(within(gcmRow).getByRole('button', { name: 'settings:cloneTools.install' })).toBeTruthy()
  })

  it('hides the GCM install action when Git is missing and GCM is missing', async () => {
    diagnostics.runDiagnostics.mockResolvedValue(makeReport({ git: 'failure', xet: 'pass', gcm: 'failure' }))
    renderSection()
    // Wait until the diagnostics report has landed so the row reflects real data.
    await screen.findByText('Git is not installed')
    const gcmRow = screen.getByTestId('clone-tool-row-gcm')
    expect(within(gcmRow).queryByRole('button', { name: 'settings:cloneTools.install' })).toBeNull()
  })

  it('recheck runs diagnostics and writes the report to the shared query', async () => {
    const initial = makeReport({ git: 'pass', xet: 'pass', gcm: 'failure' })
    const rechecked = makeReport({ git: 'pass', xet: 'pass', gcm: 'failure' })
    diagnostics.runDiagnostics.mockResolvedValueOnce(initial).mockResolvedValueOnce(rechecked)
    const client = renderSection()
    await waitFor(() => expect(client.getQueryData(['diagnostics'])).toEqual(initial))

    fireEvent.click(screen.getByRole('button', { name: 'settings:cloneTools.recheck' }))

    await waitFor(() => expect(client.getQueryData(['diagnostics'])).toEqual(rechecked))
    expect(diagnostics.runDiagnostics).toHaveBeenCalledTimes(2)
    // Recheck still reports a missing tool -> restart hint is shown.
    expect(screen.getByText('settings:cloneTools.restartHint')).toBeTruthy()
  })

  it('copies the winget command and toasts success', async () => {
    diagnostics.runDiagnostics.mockResolvedValue(makeReport({ git: 'failure', xet: 'pass', gcm: 'pass' }))
    renderSection()
    const gitRow = await screen.findByTestId('clone-tool-row-git')
    const copyButton = within(gitRow).getByRole('button', { name: 'settings:cloneTools.copyWinget' })
    fireEvent.click(copyButton)
    await waitFor(() =>
      expect(window.navigator.clipboard.writeText).toHaveBeenCalledWith('winget install --id Git.Git -e')
    )
    await waitFor(() => {
      const toasts = useToasts.getState().toasts
      expect(
        toasts.some((toast) => toast.message === 'settings:cloneTools.copied' && toast.variant === 'success')
      ).toBe(true)
    })
  })
})
