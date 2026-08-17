// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

const clones = vi.hoisted(() => ({ createClone: vi.fn() }))
const diagnostics = vi.hoisted(() => ({ runDiagnostics: vi.fn() }))
const router = vi.hoisted(() => ({ navigate: vi.fn() }))

vi.mock('@/lib/clones', () => clones)
vi.mock('@/lib/diagnostics', () => diagnostics)
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

function diagnosticReport(gitPass: boolean): DiagnosticReport {
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

function renderPage(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  render(
    <QueryClientProvider client={client}>
      <CloneCreatePage />
    </QueryClientProvider>
  )
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
  diagnostics.runDiagnostics.mockReset()
  router.navigate.mockReset()
})

beforeEach(() => {
  diagnostics.runDiagnostics.mockResolvedValue(diagnosticReport(true))
  clones.createClone.mockResolvedValue({ id: CREATED_ID } satisfies Pick<CloneRecord, 'id'>)
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
      target: { value: 'https://huggingface.co/acme/model' }
    })
    fireEvent.change(screen.getByLabelText('clones:destination.label'), {
      target: { value: 'E:\\empty-clone-dest' }
    })
    expect(createButton().disabled).toBe(true)
    fireEvent.click(createButton())
    expect(clones.createClone).not.toHaveBeenCalled()
  })

  it('does not call create when Git is missing', async () => {
    diagnostics.runDiagnostics.mockResolvedValue(diagnosticReport(false))
    renderPage()
    await waitForReady('Git is not installed')
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
})
