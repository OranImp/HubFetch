// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloneRecord } from '@hubfetch/shared'

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

const lib = vi.hoisted(() => ({
  listClones: vi.fn(),
  onClonesChanged: vi.fn()
}))

vi.mock('@/lib/clones', () => lib)

import { useClonesQuery } from './use-clones'

function clone(id: string, status: CloneRecord['status']): CloneRecord {
  return {
    id,
    attempt: 1,
    repoKind: 'model',
    repoId: `acme/${id}`,
    transport: 'https',
    destination: `E:\\Repos\\${id}`,
    auth: 'system',
    proxy: { mode: 'system' },
    status,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z'
  }
}

function wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

let listener: ((records: CloneRecord[]) => void) | undefined

beforeEach(() => {
  listener = undefined
  lib.onClonesChanged.mockImplementation((fn: (records: CloneRecord[]) => void) => {
    listener = fn
    return () => {
      if (listener === fn) listener = undefined
    }
  })
  lib.listClones.mockResolvedValue([clone('one', 'queued'), clone('two', 'running')])
})

afterEach(() => {
  cleanup()
  lib.listClones.mockReset()
  lib.onClonesChanged.mockReset()
})

describe('useClonesQuery', () => {
  it('loads the authoritative list and subscribes to clone events', async () => {
    const { result } = renderHook(() => useClonesQuery(), { wrapper })
    await waitFor(() => expect(result.current.data).toHaveLength(2))
    expect(lib.listClones).toHaveBeenCalledTimes(1)
    expect(lib.onClonesChanged).toHaveBeenCalledTimes(1)
  })

  it('applies push events as authoritative snapshots', async () => {
    const { result } = renderHook(() => useClonesQuery(), { wrapper })
    await waitFor(() => expect(result.current.data).toHaveLength(2))

    act(() => {
      listener?.([clone('one', 'queued'), clone('two', 'running'), clone('three', 'completed')])
    })

    await waitFor(() => expect(result.current.data).toHaveLength(3))
    expect(result.current.data?.map((r) => r.id)).toEqual(['one', 'two', 'three'])
  })

  it('heals a dropped event by reconciling from the authoritative list on window focus', async () => {
    const { result } = renderHook(() => useClonesQuery(), { wrapper })
    await waitFor(() => expect(result.current.data).toHaveLength(2))

    // A reconnect scenario: main changed state while this window was blurred.
    lib.listClones.mockResolvedValue([
      clone('one', 'queued'),
      clone('two', 'running'),
      clone('three', 'completed'),
      clone('four', 'failed')
    ])
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })

    await waitFor(() => expect(result.current.data).toHaveLength(4))
    expect(lib.listClones.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('unsubscribes on unmount so late events never reach a dead page', async () => {
    const { unmount } = renderHook(() => useClonesQuery(), { wrapper })
    await waitFor(() => expect(listener).toBeDefined())

    const afterUnmount: CloneRecord[] = []
    unmount()
    act(() => listener?.(afterUnmount))

    // No assertion on React state (component is gone); the unsubscribe contract
    // is proven by the mock returning a cleanup that detaches the listener.
    expect(listener).toBeUndefined()
  })
})
