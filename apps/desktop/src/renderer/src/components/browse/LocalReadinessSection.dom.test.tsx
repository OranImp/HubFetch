// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CacheReport, DownloadPlan, ExportTarget } from '@hubfetch/shared'

const ipc = vi.hoisted(() => ({ invoke: vi.fn() }))
const toasts = vi.hoisted(() => ({ push: vi.fn() }))

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

vi.mock('@/lib/ipc', () => ipc)
vi.mock('@/stores/app', () => ({
  useAppStore: (selector: (state: { settings: { hubEndpoint: null } }) => unknown) =>
    selector({ settings: { hubEndpoint: null } })
}))
vi.mock('@/components/ui/toaster', () => ({
  useToasts: (selector: (state: { push: typeof toasts.push }) => unknown) => selector(toasts)
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

import { LocalReadinessSection } from './LocalReadinessSection'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'

function makePlan(files: Array<{ path: string; alreadyCached: boolean }>): DownloadPlan {
  return {
    planId: 'plan-1',
    repoId: 'org/model',
    kind: 'model',
    revision: 'main',
    resolvedCommit: COMMIT,
    endpoint: 'https://huggingface.co',
    proxy: { mode: 'system' },
    files: files.map((file) => ({
      path: file.path,
      size: 10,
      alreadyCached: file.alreadyCached,
      coveredByLiveTask: false
    })),
    totalBytes: files.length * 10,
    totalFiles: files.length,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    digest: 'digest'
  }
}

function renderSection(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  render(
    <QueryClientProvider client={client}>
      <LocalReadinessSection
        kind="model"
        repoId="org/model"
        loading={false}
        siblings={[
          { rfilename: 'ready.gguf', size: 8 },
          { rfilename: 'README.md', size: 1 }
        ]}
      />
    </QueryClientProvider>
  )
  return client
}

afterEach(() => {
  cleanup()
  ipc.invoke.mockReset()
  toasts.push.mockReset()
})

describe('LocalReadinessSection plan and export APIs', () => {
  it('downloads and exports through typed plan/task APIs with logical identifiers', async () => {
    const exportTargets: ExportTarget[] = [
      { tool: 'ollama', detected: true },
      { tool: 'lmstudio', detected: false },
      { tool: 'comfyui', detected: false }
    ]
    const cache: CacheReport = {
      root: '/tmp/cache',
      totalSize: 0,
      repos: [],
      scannedAt: new Date().toISOString()
    }
    const plan = makePlan([{ path: 'ready.gguf', alreadyCached: true }])
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'export:targets') return exportTargets
      if (channel === 'cache:scan') return cache
      if (channel === 'downloads:plan') return plan
      if (channel === 'downloads:startPlanned') return []
      if (channel === 'export:start') return { id: 'export-1' }
      throw new Error(`unexpected channel ${channel}`)
    })

    renderSection()
    await waitFor(() => expect(screen.getByTestId('local-readiness')).toBeTruthy())

    const planCalls = ipc.invoke.mock.calls.filter((call) => call[0] === 'downloads:plan')
    expect(planCalls.length).toBeGreaterThan(0)
    const autoPlanReq = planCalls[0]?.[1] as { request: { files: string[]; repoId: string } }
    expect(autoPlanReq.request.repoId).toBe('org/model')
    expect(autoPlanReq.request.files).toEqual(['ready.gguf'])
    expect(autoPlanReq.request.files[0]).not.toMatch(/^[A-Za-z]:\\/)

    fireEvent.click(screen.getByRole('button', { name: /readiness.export/ }))
    await waitFor(() =>
      expect(ipc.invoke).toHaveBeenCalledWith('export:start', {
        request: { tool: 'ollama', kind: 'model', repoId: 'org/model', filePath: 'ready.gguf' }
      })
    )
    const exportReq = ipc.invoke.mock.calls.find((call) => call[0] === 'export:start')?.[1] as {
      request: { filePath: string }
    }
    expect(exportReq.request.filePath).toBe('ready.gguf')
    expect(exportReq.request.filePath).not.toMatch(/^[A-Za-z]:\\/)
  })
})
