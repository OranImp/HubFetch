// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExportTarget } from '@hubfetch/shared'
import { buildLocalReadiness } from '@/lib/local-readiness'
import { LocalReadinessPanel } from './LocalReadinessPanel'

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

function targets(installed: readonly ExportTarget['tool'][]): readonly ExportTarget[] {
  return (['ollama', 'lmstudio', 'comfyui'] as const).map((tool) => ({
    tool,
    detected: installed.includes(tool)
  }))
}

afterEach(() => {
  cleanup()
})

describe('LocalReadinessPanel labels and actions', () => {
  it('distinguishes detected, cached, target installed, and adapter available', () => {
    const readiness = buildLocalReadiness({
      files: [{ path: 'ready.gguf', size: 8 }],
      cachedPaths: new Set(['ready.gguf']),
      exportTargets: targets(['ollama'])
    })
    render(
      <LocalReadinessPanel
        readiness={readiness}
        downloadPending={false}
        exportPending={false}
        onDownload={vi.fn()}
        onExport={vi.fn()}
      />
    )
    expect(screen.getByTestId('local-readiness')).toBeTruthy()
    expect(screen.getByText('readiness.detected')).toBeTruthy()
    expect(screen.getByText('readiness.cached')).toBeTruthy()
    expect(document.querySelector('[data-readiness-label="detected"]')).toBeTruthy()
    expect(document.querySelector('[data-readiness-label="cached"]')).toBeTruthy()
    expect(
      document.querySelector('[data-readiness-label="target-installed"][data-tool="ollama"]')
    ).toBeTruthy()
    expect(
      document.querySelector('[data-readiness-label="adapter-available"][data-tool="ollama"]')
    ).toBeTruthy()
    expect(
      document.querySelector('[data-readiness-label="target-not-installed"][data-tool="lmstudio"]')
    ).toBeTruthy()
  })

  it('invokes download with repo-relative paths, never filesystem paths', () => {
    const onDownload = vi.fn()
    const readiness = buildLocalReadiness({
      files: [
        { path: 'model-00001-of-00002.gguf', size: 10 },
        { path: 'model-00002-of-00002.gguf', size: 10 }
      ],
      cachedPaths: new Set(['model-00001-of-00002.gguf']),
      exportTargets: targets(['ollama'])
    })
    render(
      <LocalReadinessPanel
        readiness={readiness}
        downloadPending={false}
        exportPending={false}
        onDownload={onDownload}
        onExport={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /readiness.download/ }))
    expect(onDownload).toHaveBeenCalledTimes(1)
    const paths = onDownload.mock.calls[0]?.[0] as string[]
    expect(paths).toEqual(['model-00002-of-00002.gguf'])
    expect(paths.every((path) => !path.includes('\\') && !path.startsWith('/'))).toBe(true)
    expect(screen.queryByRole('button', { name: /readiness.export/ })).toBeNull()
  })

  it('exposes export only for a cached supported file and uses a logical identifier', () => {
    const onExport = vi.fn()
    const readiness = buildLocalReadiness({
      files: [{ path: 'ready.gguf', size: 8 }],
      cachedPaths: new Set(['ready.gguf']),
      exportTargets: targets(['ollama'])
    })
    render(
      <LocalReadinessPanel
        readiness={readiness}
        downloadPending={false}
        exportPending={false}
        onDownload={vi.fn()}
        onExport={onExport}
      />
    )
    const exportButton = screen.getByRole('button', { name: /readiness.export/ })
    fireEvent.click(exportButton)
    expect(onExport).toHaveBeenCalledWith('ollama', 'ready.gguf')
    expect(onExport.mock.calls[0]?.[1]).not.toMatch(/^[A-Za-z]:\\/)
  })

  it('shows existing install guidance when the adapter exists but the target is missing', () => {
    const readiness = buildLocalReadiness({
      files: [{ path: 'ready.gguf', size: 8 }],
      cachedPaths: new Set(['ready.gguf']),
      exportTargets: targets([])
    })
    render(
      <LocalReadinessPanel
        readiness={readiness}
        downloadPending={false}
        exportPending={false}
        onDownload={vi.fn()}
        onExport={vi.fn()}
      />
    )
    expect(screen.getByText('integrations:export.ollamaMissing')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /readiness.export/ })).toBeNull()
    const text = screen.getByTestId('local-readiness').textContent ?? ''
    expect(text.toLowerCase()).not.toMatch(/vram|ram|compatib|performance|guaranteed/)
  })

  it('plans a missing shard set then exports only the cached supported file', () => {
    const onDownload = vi.fn()
    const missing = buildLocalReadiness({
      files: [
        { path: 'model-00001-of-00004.gguf', size: 10 },
        { path: 'model-00002-of-00004.gguf', size: 10 },
        { path: 'model-00004-of-00004.gguf', size: 10 }
      ],
      cachedPaths: new Set(['model-00001-of-00004.gguf']),
      exportTargets: targets(['ollama'])
    })
    const { rerender } = render(
      <LocalReadinessPanel
        readiness={missing}
        downloadPending={false}
        exportPending={false}
        onDownload={onDownload}
        onExport={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /readiness.download/ }))
    expect(onDownload).toHaveBeenCalledWith([
      'model-00002-of-00004.gguf',
      'model-00004-of-00004.gguf'
    ])
    expect(screen.queryByRole('button', { name: /readiness.export/ })).toBeNull()

    const onExport = vi.fn()
    const cachedSingle = buildLocalReadiness({
      files: [{ path: 'ready.gguf', size: 8 }],
      cachedPaths: new Set(['ready.gguf']),
      exportTargets: targets(['ollama'])
    })
    rerender(
      <LocalReadinessPanel
        readiness={cachedSingle}
        downloadPending={false}
        exportPending={false}
        onDownload={vi.fn()}
        onExport={onExport}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /readiness.export/ }))
    expect(onExport).toHaveBeenCalledWith('ollama', 'ready.gguf')
  })
})
