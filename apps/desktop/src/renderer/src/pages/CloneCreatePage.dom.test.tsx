// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
})

const clones = vi.hoisted(() => ({ createClone: vi.fn(), selectDestination: vi.fn() }))
const diagnostics = vi.hoisted(() => ({ runDiagnostics: vi.fn() }))
const cloneTools = vi.hoisted(() => ({ performCloneToolInstall: vi.fn() }))
const router = vi.hoisted(() => ({ navigate: vi.fn() }))

vi.mock('@/lib/clones', () => clones)
vi.mock('@/lib/diagnostics', () => diagnostics)
vi.mock('@/lib/clone-tools', () => cloneTools)
vi.mock('react-router', () => ({
  useNavigate: () => router.navigate
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

import { CloneCreatePage } from './CloneCreatePage'

const CREATED_ID = '11111111-1111-4111-8111-111111111111'

interface ReportOverrides {
  sshPass?: boolean
  xetUninitialized?: boolean
}

function diagnosticReport(gitPass: boolean, overrides: ReportOverrides = {}): DiagnosticReport {
  const { sshPass = true, xetUninitialized = false } = overrides
  const checkedAt = '2026-08-17T00:00:00.000Z'
  return {
    completedAt: checkedAt,
    checks: [
      {
        id: 'git.version',
        category: 'git',
        status: gitPass ? 'pass' : 'failure',
        reasonCode: gitPass ? 'ok' : 'missing',
        message: gitPass ? 'Git is installed' : 'Git is not installed',
        durationMs: 1,
        checkedAt
      },
      {
        id: 'git.xet',
        category: 'git',
        status: 'warning',
        reasonCode: xetUninitialized ? 'unconfigured' : 'missing',
        message: xetUninitialized
          ? 'Git-Xet is installed but its filters are not configured'
          : 'Git-Xet is not installed',
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
        status: sshPass ? 'pass' : 'failure',
        reasonCode: sshPass ? 'ok' : 'missing',
        message: sshPass ? 'SSH is available' : 'SSH is not available',
        durationMs: 1,
        checkedAt
      }
    ]
  }
}

function renderPage(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  render(
    <QueryClientProvider client={client}>
      <CloneCreatePage />
    </QueryClientProvider>
  )
  return client
}

async function waitForReady(gitMessage = 'Git is installed'): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'clones:title' })).toBeTruthy()
    expect(screen.getByLabelText('clones:id.label')).toBeTruthy()
    expect(screen.getByText(gitMessage)).toBeTruthy()
  })
}

function createButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /clones:create/ })
}

afterEach(() => {
  cleanup()
  clones.createClone.mockReset()
  clones.selectDestination.mockReset()
  diagnostics.runDiagnostics.mockReset()
  cloneTools.performCloneToolInstall.mockReset()
  router.navigate.mockReset()
})

beforeEach(() => {
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true
  })
  diagnostics.runDiagnostics.mockResolvedValue(diagnosticReport(true))
  clones.createClone.mockResolvedValue({ id: CREATED_ID } satisfies Pick<CloneRecord, 'id'>)
  clones.selectDestination.mockResolvedValue(null)
})

describe('CloneCreatePage', () => {
  it('renders the localized create surface', async () => {
    renderPage()
    await waitForReady()
    expect(screen.getByLabelText('clones:destination.label')).toBeTruthy()
    expect(createButton()).toBeTruthy()
  })

  it('does not call create when the repo id is malformed', async () => {
    renderPage()
    await waitForReady()
    fireEvent.change(screen.getByLabelText('clones:id.label'), {
      target: { value: 'https://example.com/x/y' }
    })
    fireEvent.change(screen.getByLabelText('clones:destination.label'), {
      target: { value: 'E:\\empty-clone-dest' }
    })
    expect(createButton().disabled).toBe(true)
    fireEvent.click(createButton())
    expect(clones.createClone).not.toHaveBeenCalled()
  })

  it('shows a live repo id error without a submit attempt', async () => {
    renderPage()
    await waitForReady()
    fireEvent.change(screen.getByLabelText('clones:id.label'), {
      target: { value: 'acme' }
    })
    expect(screen.getByText('clones:id.invalid')).toBeTruthy()
    expect(clones.createClone).not.toHaveBeenCalled()
  })

  it('enables create when the form is valid and shows a disabled reason when a field is invalid', async () => {
    renderPage()
    await waitForReady()
    fireEvent.change(screen.getByLabelText('clones:id.label'), {
      target: { value: 'acme/demo-model' }
    })
    fireEvent.change(screen.getByLabelText('clones:destination.label'), {
      target: { value: 'E:\\empty-clone-dest' }
    })
    expect(createButton().disabled).toBe(false)
    expect(screen.queryByText('clones:createDisabled.invalidRepoId')).toBeNull()

    fireEvent.change(screen.getByLabelText('clones:id.label'), {
      target: { value: 'acme' }
    })
    expect(createButton().disabled).toBe(true)
    expect(screen.getByText('clones:createDisabled.invalidRepoId')).toBeTruthy()
  })

  it('normalizes a pasted Hugging Face URL before create', async () => {
    renderPage()
    await waitForReady()
    fireEvent.change(screen.getByLabelText('clones:id.label'), {
      target: { value: 'https://huggingface.co/acme/model' }
    })
    fireEvent.change(screen.getByLabelText('clones:destination.label'), {
      target: { value: 'E:\\empty-clone-dest' }
    })
    expect(createButton().disabled).toBe(false)
    fireEvent.click(createButton())
    await waitFor(() => expect(clones.createClone).toHaveBeenCalledTimes(1))
    expect(clones.createClone.mock.calls[0]?.[0]).toMatchObject({
      id: 'acme/model'
    })
  })

  it('does not call create when Git is missing', async () => {
    diagnostics.runDiagnostics.mockResolvedValue(diagnosticReport(false))
    renderPage()
    await waitForReady('Git is not installed')
    // The Git row offers the guided actions: open the official page + copy winget.
    const gitRow = screen.getByTestId('clone-prereq-row-git')
    expect(within(gitRow).getByRole('button', { name: 'clones:diagnostics.install' })).toBeTruthy()
    expect(
      within(gitRow).getByRole('button', { name: 'clones:diagnostics.copyWinget' })
    ).toBeTruthy()
    fireEvent.change(screen.getByLabelText('clones:id.label'), {
      target: { value: 'acme/demo-model' }
    })
    fireEvent.change(screen.getByLabelText('clones:destination.label'), {
      target: { value: 'E:\\empty-clone-dest' }
    })
    expect(createButton().disabled).toBe(true)
    fireEvent.click(createButton())
    expect(clones.createClone).not.toHaveBeenCalled()
  })

  it('shows no actions on the SSH row and still blocks create for SSH transport', async () => {
    diagnostics.runDiagnostics.mockResolvedValue(diagnosticReport(true, { sshPass: false }))
    renderPage()
    await waitForReady()
    fireEvent.click(screen.getByRole('radio', { name: 'clones:transport.ssh' }))
    const sshRow = await screen.findByTestId('clone-prereq-row-ssh')
    expect(within(sshRow).queryByRole('button', { name: 'clones:diagnostics.install' })).toBeNull()
    expect(
      within(sshRow).queryByRole('button', { name: 'clones:diagnostics.copyWinget' })
    ).toBeNull()
    expect(
      within(sshRow).queryByRole('button', { name: 'clones:diagnostics.copyConfigure' })
    ).toBeNull()
    fireEvent.change(screen.getByLabelText('clones:id.label'), {
      target: { value: 'acme/demo-model' }
    })
    fireEvent.change(screen.getByLabelText('clones:destination.label'), {
      target: { value: 'E:\\empty-clone-dest' }
    })
    expect(createButton().disabled).toBe(true)
    fireEvent.click(createButton())
    expect(clones.createClone).not.toHaveBeenCalled()
  })

  it('offers copy-configure only when Git-Xet is installed but uninitialized', async () => {
    diagnostics.runDiagnostics.mockResolvedValue(diagnosticReport(true, { xetUninitialized: true }))
    renderPage()
    await waitForReady()
    const xetRow = screen.getByTestId('clone-prereq-row-git-xet')
    expect(within(xetRow).queryByRole('button', { name: 'clones:diagnostics.install' })).toBeNull()
    expect(
      within(xetRow).queryByRole('button', { name: 'clones:diagnostics.copyWinget' })
    ).toBeNull()
    const copyConfigure = within(xetRow).getByRole('button', {
      name: 'clones:diagnostics.copyConfigure'
    })
    fireEvent.click(copyConfigure)
    await waitFor(() =>
      expect(window.navigator.clipboard.writeText).toHaveBeenCalledWith('git xet install')
    )
    // Copying the configure command never opens a download page.
    expect(cloneTools.performCloneToolInstall).not.toHaveBeenCalled()
  })

  it('recheck writes the report to the shared query and shows the restart hint when Git is still missing', async () => {
    const initial = diagnosticReport(false)
    const rechecked = diagnosticReport(false)
    diagnostics.runDiagnostics.mockResolvedValueOnce(initial).mockResolvedValueOnce(rechecked)
    const client = renderPage()
    await waitForReady('Git is not installed')
    fireEvent.click(screen.getByRole('button', { name: 'clones:diagnostics.recheck' }))
    await waitFor(() => expect(client.getQueryData(['diagnostics'])).toEqual(rechecked))
    expect(diagnostics.runDiagnostics).toHaveBeenCalledTimes(2)
    expect(screen.getByText('clones:diagnostics.restartHint')).toBeTruthy()
  })

  it('creates once and navigates with the new task selected', async () => {
    let resolveCreate: ((value: Pick<CloneRecord, 'id'>) => void) | undefined
    clones.createClone.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve
        })
    )
    renderPage()
    await waitForReady()
    fireEvent.change(screen.getByLabelText('clones:id.label'), {
      target: { value: 'acme/demo-model' }
    })
    fireEvent.change(screen.getByLabelText('clones:destination.label'), {
      target: { value: 'E:\\empty-clone-dest' }
    })
    const button = createButton()
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(clones.createClone).toHaveBeenCalledTimes(1))
    resolveCreate?.({ id: CREATED_ID })
    await waitFor(() =>
      expect(router.navigate).toHaveBeenCalledWith(`/clones?selected=${CREATED_ID}`)
    )
    expect(clones.createClone).toHaveBeenCalledTimes(1)
    expect(clones.createClone.mock.calls[0]?.[0]).toMatchObject({
      kind: 'model',
      id: 'acme/demo-model',
      transport: 'https',
      destination: 'E:\\empty-clone-dest',
      auth: 'system'
    })
  })

  it('keeps the typed destination when the folder picker is cancelled', async () => {
    clones.selectDestination.mockResolvedValue(null)
    renderPage()
    await waitForReady()
    const dest = screen.getByLabelText('clones:destination.label') as HTMLInputElement
    fireEvent.change(dest, { target: { value: 'E:\\typed-manual' } })
    fireEvent.click(screen.getByRole('button', { name: 'clones:destination.select' }))
    await waitFor(() => expect(clones.selectDestination).toHaveBeenCalledTimes(1))
    expect(dest.value).toBe('E:\\typed-manual')
    expect(screen.queryByText('clones:destination.invalid')).toBeNull()
    expect(screen.queryByText('clones:destination.inaccessible')).toBeNull()
  })

  it('fills the destination with the picker path and clears a field error', async () => {
    clones.selectDestination.mockResolvedValue('E:\\canonical-picked')
    renderPage()
    await waitForReady()
    const dest = screen.getByLabelText('clones:destination.label') as HTMLInputElement
    fireEvent.blur(dest)
    expect(screen.getByText('clones:destination.invalid')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'clones:destination.select' }))
    await waitFor(() => expect(dest.value).toBe('E:\\canonical-picked'))
    expect(screen.queryByText('clones:destination.invalid')).toBeNull()
  })

  it('shows a localized destination error when the picker rejects a non-directory', async () => {
    clones.selectDestination.mockRejectedValue(
      new Error('Selected clone destination is not a regular directory')
    )
    renderPage()
    await waitForReady()
    const dest = screen.getByLabelText('clones:destination.label') as HTMLInputElement
    fireEvent.change(dest, { target: { value: 'E:\\typed-manual' } })
    fireEvent.click(screen.getByRole('button', { name: 'clones:destination.select' }))
    await waitFor(() => expect(screen.getByText('clones:destination.invalid')).toBeTruthy())
    expect(dest.value).toBe('E:\\typed-manual')
  })
})
