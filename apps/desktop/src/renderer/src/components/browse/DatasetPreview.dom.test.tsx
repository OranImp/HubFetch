// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), openExternal: vi.fn() }))
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
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => undefined
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => undefined
  }
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
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'datasetPreview.pageScope' || key === 'detail:datasetPreview.pageScope') {
        return 'current page (25 rows maximum)'
      }
      if (!opts) return key
      let out = key
      for (const [name, value] of Object.entries(opts)) {
        out = out.replace(`{{${name}}}`, String(value))
      }
      return out
    }
  })
}))

import { DatasetPreview } from './DatasetPreview'

afterEach(() => {
  cleanup()
  ipc.invoke.mockReset()
  toasts.push.mockReset()
})

const PAGE = {
  columns: ['text', 'label', 'meta'],
  rows: [
    ['hello', 'pos', '{"a":1}'],
    ['world', 'neg', ''],
    ['hello world', 'pos', '{"a":2}']
  ],
  values: [
    ['hello', 'pos', { a: 1 }],
    ['world', 'neg', null],
    ['hello world', 'pos', { a: 2 }]
  ],
  total: 3
}

function renderPreview(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  })
  render(
    <QueryClientProvider client={client}>
      <DatasetPreview repoId="owner/ds" />
    </QueryClientProvider>
  )
  return client
}

describe('DatasetPreview page tools', () => {
  it('shows selectors, page scope, profile, filter, columns, and export', async () => {
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'hub:datasetSplits') return [{ config: 'default', split: 'train' }]
      if (channel === 'hub:datasetRows') return PAGE
      return null
    })
    renderPreview()
    expect(await screen.findByLabelText('datasetPreview.config')).toBeTruthy()
    expect(screen.getByLabelText('datasetPreview.split')).toBeTruthy()
    expect(screen.getByText('current page (25 rows maximum)')).toBeTruthy()
    expect(screen.getByLabelText('datasetPreview.filter')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'datasetPreview.columns' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'datasetPreview.exportCsv' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'datasetPreview.exportJsonl' })).toBeTruthy()
    expect(screen.getByText(/text/)).toBeTruthy()
    expect(screen.getByText('hello', { exact: true })).toBeTruthy()

    fireEvent.change(screen.getByLabelText('datasetPreview.filter'), {
      target: { value: 'world' }
    })
    await waitFor(() => {
      expect(screen.queryByText('hello', { exact: true })).toBeNull()
      expect(screen.getByText('world', { exact: true })).toBeTruthy()
    })
  })

  it('hides a column from the table without dropping the source page', async () => {
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'hub:datasetSplits') return [{ config: 'default', split: 'train' }]
      if (channel === 'hub:datasetRows') return PAGE
      return null
    })
    renderPreview()
    await screen.findByText('hello', { exact: true })
    fireEvent.click(screen.getByRole('button', { name: 'datasetPreview.columns' }))
    const labelItem = await screen.findByRole('menuitemcheckbox', { name: 'label' })
    fireEvent.click(labelItem)
    await waitFor(() => {
      const table = screen.getByRole('table')
      expect(within(table).queryByText('pos')).toBeNull()
      expect(within(table).getByText('hello')).toBeTruthy()
    })
  })

  it('exports the current page and surfaces cancel without a toast', async () => {
    ipc.invoke.mockImplementation(async (channel: string, payload?: unknown) => {
      if (channel === 'hub:datasetSplits') return [{ config: 'default', split: 'train' }]
      if (channel === 'hub:datasetRows') return PAGE
      if (channel === 'dataset:exportPage') {
        expect(payload).toEqual({
          repoId: 'owner/ds',
          config: 'default',
          split: 'train',
          offset: 0,
          length: 25,
          format: 'csv'
        })
        return { status: 'canceled' }
      }
      return null
    })
    renderPreview()
    await screen.findByText('hello', { exact: true })
    fireEvent.click(screen.getByRole('button', { name: 'datasetPreview.exportCsv' }))
    await waitFor(() => {
      expect(ipc.invoke).toHaveBeenCalledWith('dataset:exportPage', expect.any(Object))
    })
    expect(toasts.push).not.toHaveBeenCalled()
  })

  it('falls back when splits are unavailable', async () => {
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'hub:datasetSplits') throw new Error('viewer down')
      if (channel === 'hub:datasetSampleRows') return null
      return null
    })
    renderPreview()
    expect(await screen.findByText('detail:datasetPreview.unavailable')).toBeTruthy()
  })

  it('does not add a second dataset route', () => {
    const app = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf8')
    expect(app.match(/path="datasets/g)).toEqual(['path="datasets'])
  })
})
