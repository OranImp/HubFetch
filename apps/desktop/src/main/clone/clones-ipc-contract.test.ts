// apps/desktop/src/main/clone/clones-ipc-contract.test.ts
//
// Todo 33 contract tests for the typed clone IPC surface:
//   - type-level: every operation/event response shape + CloneBridge methods
//   - runtime: every clone request schema (valid/invalid/oversized/raw url/
//     token/forged status/unknown field rejected BEFORE the manager)
//   - hostile sender: the REAL central wrapper (Todo 18) rejects a rogue frame
//     before any clone manager call
//   - listeners unsubscribe without leaking
//   - AST policy: zero `ipcRenderer` usage anywhere in the renderer source
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type {
  CloneRecord,
  CloneRequest,
  IpcEventPayload,
  IpcRequest,
  IpcResponse,
  RendererApi
} from '@hubfetch/shared'
import { cloneRecordSchema, IPC_INVOKE_CHANNELS, ipcRequestSchemas } from '@hubfetch/shared'
import type { CloneBridge } from '@hubfetch/shared'
import { makeRogueEvent, PACKAGED_ENTRY, type ClonesIpcMock } from './clones-ipc-test-utils'

// ---------------------------------------------------------------------------
// Electron mock: captures ipcMain.handle registrations, routes ipcRenderer
// invokes to them with a TRUSTED sender, and records event listeners so the
// real preload bridge can be driven end-to-end.
// ---------------------------------------------------------------------------
// vi.hoisted runs BEFORE imports, so the container is built inline (no
// imported helpers may be referenced here).
const mock: ClonesIpcMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
  rendererListeners: new Map<string, Array<(event: unknown, payload: unknown) => void>>(),
  exposed: { key: null as string | null, api: null as RendererApi | null },
  trustedUrl: 'file:///E:/Apps/HubFetch/resources/app.asar/out/renderer/index.html',
  openPathCalls: [] as string[]
}))

vi.mock('electron', () => {
  const trustedEvent = () => {
    const frame = {}
    return {
      sender: { id: 7, getURL: () => mock.trustedUrl, mainFrame: frame },
      senderFrame: frame
    }
  }
  return {
    app: {
      isPackaged: false,
      getAppPath: () => 'C:\\qa\\apps\\desktop',
      getVersion: () => '0.2.0-qa',
      getLocale: () => 'en-US',
      getPath: () => 'C:\\qa\\appdata',
      setPath: () => undefined,
      setLoginItemSettings: () => undefined,
      setName: () => undefined,
      whenReady: () => Promise.resolve(),
      on: () => undefined,
      quit: () => undefined,
      exit: () => undefined
    },
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
        mock.handlers.set(channel, handler)
      }
    },
    ipcRenderer: {
      invoke: (channel: string, payload: unknown) => {
        const handler = mock.handlers.get(channel)
        if (!handler) return Promise.reject(new Error(`no main handler registered for ${channel}`))
        return Promise.resolve(handler(trustedEvent(), payload))
      },
      on: (channel: string, listener: (payload: unknown) => void) => {
        const arr = mock.rendererListeners.get(channel) ?? []
        arr.push(listener)
        mock.rendererListeners.set(channel, arr)
      },
      removeListener: (channel: string, listener: (payload: unknown) => void) => {
        const arr = mock.rendererListeners.get(channel) ?? []
        mock.rendererListeners.set(
          channel,
          arr.filter((entry) => entry !== listener)
        )
      }
    },
    contextBridge: {
      exposeInMainWorld: (key: string, api: unknown) => {
        mock.exposed.key = key
        mock.exposed.api = api as RendererApi
      }
    },
    BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true })
    },
    shell: {
      openExternal: async () => undefined,
      openPath: async (path: string) => {
        mock.openPathCalls.push(path)
        return ''
      },
      showItemInFolder: () => undefined
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value, 'utf8'),
      decryptString: (buffer: Buffer) => buffer.toString('utf8')
    },
    net: { isOnline: () => true },
    session: undefined,
    Notification: class {},
    Menu: {
      buildFromTemplate: () => ({ popup: () => undefined, append: () => undefined }),
      setApplicationMenu: () => undefined
    },
    Tray: class {},
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }) }
  }
})

// Loading the REAL preload populates `mock.exposed.api` (window.hubfetch).
import '../../preload/index'

import { makeClonesIpcHarness } from './clones-ipc-test-utils'

const UUID = '123e4567-e89b-12d3-a456-426614174000'
const UUID_2 = '123e4567-e89b-12d3-a456-426614174001'

function makeValidRequest(destination = 'C:\\qa\\clone-dest'): CloneRequest {
  return {
    kind: 'model',
    id: 'org/repo',
    transport: 'https',
    destination,
    auth: 'none',
    proxy: { mode: 'system' }
  }
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${label}`)
    await new Promise((r) => setImmediate(r))
  }
}

describe('clone IPC contract (type-level)', () => {
  it('types every clone operation response against CloneRecord', () => {
    expectTypeOf<IpcResponse<'clones:list'>>().toEqualTypeOf<CloneRecord[]>()
    expectTypeOf<IpcResponse<'clones:get'>>().toEqualTypeOf<CloneRecord | null>()
    expectTypeOf<IpcResponse<'clones:create'>>().toEqualTypeOf<CloneRecord>()
    expectTypeOf<IpcResponse<'clones:cancel'>>().toEqualTypeOf<CloneRecord[]>()
    expectTypeOf<IpcResponse<'clones:retry'>>().toEqualTypeOf<CloneRecord>()
    expectTypeOf<IpcResponse<'clones:openDestination'>>().toEqualTypeOf<void>()
    expectTypeOf<IpcResponse<'clones:remove'>>().toEqualTypeOf<CloneRecord[]>()
    expectTypeOf<IpcResponse<'clones:selectDestination'>>().toEqualTypeOf<string | null>()
  })

  it('types clones:create/retry requests as the validated CloneRequest', () => {
    expectTypeOf<IpcRequest<'clones:create'>>().toEqualTypeOf<{ request: CloneRequest }>()
    expectTypeOf<IpcRequest<'clones:retry'>>().toEqualTypeOf<{
      parentId: string
      request: CloneRequest
    }>()
    expectTypeOf<IpcRequest<'clones:get'>>().toEqualTypeOf<{ id: string }>()
    expectTypeOf<IpcRequest<'clones:list'>>().toEqualTypeOf<void>()
    expectTypeOf<IpcRequest<'clones:remove'>>().toEqualTypeOf<{ id: string }>()
    expectTypeOf<IpcRequest<'clones:selectDestination'>>().toEqualTypeOf<void>()
  })

  it('binds the evt:clones event payload to CloneRecord[]', () => {
    expectTypeOf<IpcEventPayload<'evt:clones'>>().toEqualTypeOf<CloneRecord[]>()
  })

  it('names every CloneBridge method with the contract signatures', () => {
    const bridge = {
      list: undefined,
      get: undefined,
      create: undefined,
      cancel: undefined,
      retry: undefined,
      openDestination: undefined,
      remove: undefined,
      selectDestination: undefined,
      onClonesChanged: undefined
    } as unknown as CloneBridge
    expectTypeOf(bridge.list).returns.toEqualTypeOf<Promise<CloneRecord[]>>()
    expectTypeOf(bridge.get).parameter(0).toBeString()
    expectTypeOf(bridge.get).returns.toEqualTypeOf<Promise<CloneRecord | null>>()
    expectTypeOf(bridge.create).parameter(0).toEqualTypeOf<CloneRequest>()
    expectTypeOf(bridge.create).returns.toEqualTypeOf<Promise<CloneRecord>>()
    expectTypeOf(bridge.cancel).parameter(0).toBeString()
    expectTypeOf(bridge.cancel).returns.toEqualTypeOf<Promise<CloneRecord[]>>()
    expectTypeOf(bridge.retry).parameter(0).toBeString()
    expectTypeOf(bridge.retry).parameter(1).toEqualTypeOf<CloneRequest>()
    expectTypeOf(bridge.retry).returns.toEqualTypeOf<Promise<CloneRecord>>()
    expectTypeOf(bridge.openDestination).parameter(0).toBeString()
    expectTypeOf(bridge.openDestination).returns.toEqualTypeOf<Promise<void>>()
    expectTypeOf(bridge.remove).parameter(0).toBeString()
    expectTypeOf(bridge.remove).returns.toEqualTypeOf<Promise<CloneRecord[]>>()
    expectTypeOf(bridge.selectDestination).parameters.toEqualTypeOf<[]>()
    expectTypeOf(bridge.selectDestination).returns.toEqualTypeOf<Promise<string | null>>()
    expectTypeOf(bridge.onClonesChanged)
      .parameter(0)
      .toEqualTypeOf<(records: CloneRecord[]) => void>()
    expectTypeOf(bridge.onClonesChanged).returns.toEqualTypeOf<() => void>()
  })

  it('exposes clones on window.hubfetch alongside diagnostics', () => {
    const api = {
      invoke: undefined,
      on: undefined,
      diagnostics: {},
      clones: {}
    } as unknown as RendererApi
    expectTypeOf(api.clones).toEqualTypeOf<CloneBridge>()
    expectTypeOf(api.diagnostics).toBeObject()
  })
})

describe('clone IPC request schemas (runtime)', () => {
  it('clones:create accepts a valid request, with the proxy override optional', () => {
    const schema = ipcRequestSchemas['clones:create']!
    expect(schema.safeParse({ request: makeValidRequest() }).success).toBe(true)
    const noProxy: CloneRequest = {
      kind: 'dataset',
      id: 'org/ds',
      transport: 'ssh',
      destination: 'C:\\qa\\clone-dest',
      auth: 'system'
    }
    expect(schema.safeParse({ request: noProxy }).success).toBe(true)
  })

  it('clones:create rejects a raw URL, token, forged status, and unknown fields', () => {
    const schema = ipcRequestSchemas['clones:create']!
    const request = makeValidRequest()
    // Raw URL nested in the request: the strict cloneRequestSchema refuses it.
    expect(
      schema.safeParse({ request: { ...request, url: 'https://evil.example/x.git' } }).success
    ).toBe(false)
    // Token bytes nested in the request: rejected before the manager.
    expect(schema.safeParse({ request: { ...request, token: 'hf_abc123' } }).success).toBe(false)
    // Forged status: the renderer never chooses status.
    expect(schema.safeParse({ request: { ...request, status: 'completed' } }).success).toBe(false)
    // Top-level smuggled fields: the OUTER strict object rejects them too.
    expect(schema.safeParse({ request, token: 'hf_abc123' }).success).toBe(false)
    expect(schema.safeParse({ request, url: 'https://evil.example/x.git' }).success).toBe(false)
    expect(schema.safeParse({ request, status: 'running' }).success).toBe(false)
  })

  it('clones:create rejects oversized and option-injecting clone fields', () => {
    const schema = ipcRequestSchemas['clones:create']!
    const request = makeValidRequest()
    // Oversized destination (>1024) — the schema caps it before any manager work.
    expect(
      schema.safeParse({ request: { ...request, destination: 'x'.repeat(1025) } }).success
    ).toBe(false)
    // Oversized id (>255 total) — the strict namespace/name schema refuses it.
    expect(
      schema.safeParse({ request: { ...request, id: `org/${'x'.repeat(255)}` } }).success
    ).toBe(false)
    // Option-injecting revision name (leading -) is refused.
    expect(
      schema.safeParse({ request: { ...request, revision: { kind: 'branch', name: '-evil' } } })
        .success
    ).toBe(false)
    // Credential-bearing proxy override is refused before it can be applied.
    expect(
      schema.safeParse({
        request: {
          ...request,
          proxy: { mode: 'manual', url: 'http://user:pass@127.0.0.1:7897' }
        }
      }).success
    ).toBe(false)
  })

  it('clones:get/cancel/openDestination/remove require branded UUID ids', () => {
    for (const channel of [
      'clones:get',
      'clones:cancel',
      'clones:openDestination',
      'clones:remove'
    ] as const) {
      const schema = ipcRequestSchemas[channel]!
      expect(schema.safeParse({ id: 'not-a-uuid' }).success).toBe(false)
      expect(schema.safeParse({ id: 'f'.repeat(36) }).success).toBe(false)
      expect(schema.safeParse({ id: '' }).success).toBe(false)
      expect(schema.safeParse({ id: UUID }).success).toBe(true)
      expect(schema.safeParse({ id: UUID, extra: true }).success).toBe(false)
    }
  })

  it('clones:retry requires a UUID parentId plus a validated request', () => {
    const schema = ipcRequestSchemas['clones:retry']!
    expect(schema.safeParse({ parentId: UUID, request: makeValidRequest() }).success).toBe(true)
    expect(schema.safeParse({ parentId: 'not-a-uuid', request: makeValidRequest() }).success).toBe(
      false
    )
    expect(
      schema.safeParse({ parentId: UUID, request: { ...makeValidRequest(), token: 'x' } }).success
    ).toBe(false)
    expect(
      schema.safeParse({ parentId: UUID, request: makeValidRequest(), token: 'hf_x' }).success
    ).toBe(false)
  })

  it('clones:list is a void-request channel (no schema entry)', () => {
    expect(ipcRequestSchemas['clones:list']).toBeUndefined()
    expectTypeOf<IpcRequest<'clones:list'>>().toEqualTypeOf<void>()
  })

  it('clones:selectDestination is a void-request channel (no schema entry)', () => {
    expect(ipcRequestSchemas['clones:selectDestination']).toBeUndefined()
    expectTypeOf<IpcRequest<'clones:selectDestination'>>().toEqualTypeOf<void>()
  })

  it('allowlist covers clones:remove and schema-absent clones:selectDestination', () => {
    expect(IPC_INVOKE_CHANNELS.includes('clones:remove')).toBe(true)
    expect(IPC_INVOKE_CHANNELS.includes('clones:selectDestination')).toBe(true)
    expect(ipcRequestSchemas['clones:remove']).toBeDefined()
    expect(ipcRequestSchemas['clones:selectDestination']).toBeUndefined()
  })
})

describe('central wrapper gates the clone operations (Todo 18)', () => {
  it('rejects a rogue sender frame before any clone manager call', async () => {
    const harness = makeClonesIpcHarness(mock)
    try {
      const listSpy = vi.spyOn(harness.manager, 'list')
      const createSpy = vi.spyOn(harness.manager, 'create')
      const cancelSpy = vi.spyOn(harness.manager, 'cancel')
      const retrySpy = vi.spyOn(harness.manager, 'retry')
      const rogue = makeRogueEvent('https://evil.example/')

      const createHandler = mock.handlers.get('clones:create')!
      await expect(
        Promise.resolve(createHandler(rogue, { request: makeValidRequest() }))
      ).rejects.toThrow(/IPC sender rejected/)
      expect(createSpy).not.toHaveBeenCalled()

      const listHandler = mock.handlers.get('clones:list')!
      await expect(Promise.resolve(listHandler(rogue, undefined))).rejects.toThrow(
        /IPC sender rejected/
      )
      expect(listSpy).not.toHaveBeenCalled()

      const cancelHandler = mock.handlers.get('clones:cancel')!
      await expect(Promise.resolve(cancelHandler(rogue, { id: UUID }))).rejects.toThrow(
        /IPC sender rejected/
      )
      expect(cancelSpy).not.toHaveBeenCalled()

      const retryHandler = mock.handlers.get('clones:retry')!
      await expect(
        Promise.resolve(retryHandler(rogue, { parentId: UUID, request: makeValidRequest() }))
      ).rejects.toThrow(/IPC sender rejected/)
      expect(retrySpy).not.toHaveBeenCalled()

      const getHandler = mock.handlers.get('clones:get')!
      await expect(Promise.resolve(getHandler(rogue, { id: UUID }))).rejects.toThrow(
        /IPC sender rejected/
      )
      const openHandler = mock.handlers.get('clones:openDestination')!
      await expect(Promise.resolve(openHandler(rogue, { id: UUID }))).rejects.toThrow(
        /IPC sender rejected/
      )

      const removeSpy = vi.spyOn(harness.manager, 'remove')
      const dialogSpy = vi.spyOn(
        (await import('electron')).dialog,
        'showOpenDialog'
      )
      const removeHandler = mock.handlers.get('clones:remove')!
      await expect(Promise.resolve(removeHandler(rogue, { id: UUID }))).rejects.toThrow(
        /IPC sender rejected/
      )
      expect(removeSpy).not.toHaveBeenCalled()
      const selectHandler = mock.handlers.get('clones:selectDestination')!
      await expect(Promise.resolve(selectHandler(rogue, undefined))).rejects.toThrow(
        /IPC sender rejected/
      )
      expect(dialogSpy).not.toHaveBeenCalled()
    } finally {
      harness.cleanup()
    }
  })

  it('rejects invalid payloads through the real wrapper with zero manager calls', async () => {
    const harness = makeClonesIpcHarness(mock)
    try {
      const createSpy = vi.spyOn(harness.manager, 'create')
      const cancelSpy = vi.spyOn(harness.manager, 'cancel')
      const retrySpy = vi.spyOn(harness.manager, 'retry')
      const listSpy = vi.spyOn(harness.manager, 'list')
      const event = mock.handlers.get('clones:create')
      const frame = {}
      const trusted = {
        sender: { id: 7, getURL: () => PACKAGED_ENTRY, mainFrame: frame },
        senderFrame: frame
      }

      // A forged status payload passes sender trust but fails Zod FIRST.
      await expect(
        Promise.resolve(
          (event as (e: unknown, p: unknown) => unknown)(trusted, {
            request: { ...makeValidRequest(), status: 'completed' }
          })
        )
      ).rejects.toThrow(/Invalid payload/)
      expect(createSpy).not.toHaveBeenCalled()

      const cancelEvent = mock.handlers.get('clones:cancel')
      await expect(
        Promise.resolve((cancelEvent as (e: unknown, p: unknown) => unknown)(trusted, { id: 'x' }))
      ).rejects.toThrow(/Invalid payload/)
      expect(cancelSpy).not.toHaveBeenCalled()

      const retryEvent = mock.handlers.get('clones:retry')
      await expect(
        Promise.resolve(
          (retryEvent as (e: unknown, p: unknown) => unknown)(trusted, {
            parentId: 'bad',
            request: makeValidRequest()
          })
        )
      ).rejects.toThrow(/Invalid payload/)
      expect(retrySpy).not.toHaveBeenCalled()

      const listEvent = mock.handlers.get('clones:list')
      await expect(
        Promise.resolve((listEvent as (e: unknown, p: unknown) => unknown)(trusted, { id: UUID }))
      ).rejects.toThrow(/accepts no payload/)
      expect(listSpy).not.toHaveBeenCalled()

      const removeSpy = vi.spyOn(harness.manager, 'remove')
      const dialogSpy = vi.spyOn(
        (await import('electron')).dialog,
        'showOpenDialog'
      )
      const removeEvent = mock.handlers.get('clones:remove')
      await expect(
        Promise.resolve(
          (removeEvent as (e: unknown, p: unknown) => unknown)(trusted, { id: 'not-a-uuid' })
        )
      ).rejects.toThrow(/Invalid payload/)
      expect(removeSpy).not.toHaveBeenCalled()
      await expect(
        Promise.resolve(
          (removeEvent as (e: unknown, p: unknown) => unknown)(trusted, { id: UUID, extra: true })
        )
      ).rejects.toThrow(/Invalid payload/)
      expect(removeSpy).not.toHaveBeenCalled()

      const selectEvent = mock.handlers.get('clones:selectDestination')
      await expect(
        Promise.resolve(
          (selectEvent as (e: unknown, p: unknown) => unknown)(trusted, { path: 'C:\\\\qa' })
        )
      ).rejects.toThrow(/accepts no payload/)
      expect(dialogSpy).not.toHaveBeenCalled()
      await expect(
        Promise.resolve((selectEvent as (e: unknown, p: unknown) => unknown)(trusted, ''))
      ).rejects.toThrow(/accepts no payload/)
      expect(dialogSpy).not.toHaveBeenCalled()
    } finally {
      harness.cleanup()
    }
  })

  it('preload CloneBridge exposes remove and selectDestination with contract arities', async () => {
    const harness = makeClonesIpcHarness(mock)
    try {
      expect(typeof harness.api.clones.remove).toBe('function')
      expect(harness.api.clones.remove.length).toBe(1)
      expect(typeof harness.api.clones.selectDestination).toBe('function')
      expect(harness.api.clones.selectDestination.length).toBe(0)
      // Real handler: removing the sole terminal record returns the empty list.
      const created = await harness.api.clones.create(
        makeValidRequest(join(harness.scratchDir, 'remove-contract'))
      )
      await waitFor(() => harness.store.get(created.id)?.status === 'completed', 'completed')
      const removed = await harness.api.clones.remove(created.id)
      expect(removed).toEqual([])
      // Real handler: the owner-bound picker opens the OS dialog; cancel -> null.
      const dialogSpy = vi.spyOn((await import('electron')).dialog, 'showOpenDialog')
      await expect(harness.api.clones.selectDestination()).resolves.toBeNull()
      expect(dialogSpy).toHaveBeenCalled()
    } finally {
      harness.cleanup()
    }
  })

  it('trusted clones:remove removes a terminal row; any selectDestination payload is rejected', async () => {
    const harness = makeClonesIpcHarness(mock)
    try {
      const dialogSpy = vi.spyOn((await import('electron')).dialog, 'showOpenDialog')
      const frame = {}
      const trusted = {
        sender: { id: 7, getURL: () => PACKAGED_ENTRY, mainFrame: frame },
        senderFrame: frame
      }
      const removeEvent = mock.handlers.get('clones:remove') as (
        e: unknown,
        p: unknown
      ) => unknown
      const created = await harness.api.clones.create(
        makeValidRequest(join(harness.scratchDir, 'trusted-remove'))
      )
      await waitFor(() => harness.store.get(created.id)?.status === 'completed', 'completed')
      const removed = (await Promise.resolve(
        removeEvent(trusted, { id: created.id })
      )) as Array<{ id: string }>
      expect(removed.some((record) => record.id === created.id)).toBe(false)
      expect(harness.store.list().some((record) => record.id === created.id)).toBe(false)
      // Trusted void request opens the OS dialog; the mocked dialog cancels -> null.
      const selectEvent = mock.handlers.get('clones:selectDestination') as (
        e: unknown,
        p: unknown
      ) => unknown
      await expect(Promise.resolve(selectEvent(trusted, undefined))).resolves.toBeNull()
      expect(dialogSpy).toHaveBeenCalled()
      // Any payload on the void-request channel is rejected before the dialog.
      await expect(Promise.resolve(selectEvent(trusted, { id: UUID }))).rejects.toThrow(
        /accepts no payload/
      )
    } finally {
      harness.cleanup()
    }
  })

  it('preload rejects an unknown channel before touching IPC', async () => {
    const harness = makeClonesIpcHarness(mock)
    try {
      const listSpy = vi.spyOn(harness.manager, 'list')
      await expect(
        harness.api.invoke('clones:banish' as never, undefined as never)
      ).rejects.toThrow(/Unknown IPC channel/)
      expect(listSpy).not.toHaveBeenCalled()
    } finally {
      harness.cleanup()
    }
  })

  it('onClonesChanged subscribes and unsubscribes without leaking listeners', async () => {
    const harness = makeClonesIpcHarness(mock)
    try {
      mock.rendererListeners.delete('evt:clones')
      const seen: CloneRecord[][] = []
      const unsubscribe = harness.api.clones.onClonesChanged((records) => seen.push(records))
      const payload: CloneRecord[] = []
      for (const listener of mock.rendererListeners.get('evt:clones') ?? []) listener(null, payload)
      expect(seen.length).toBe(1)

      // Unsubscribe removes exactly the wrapped listener — no leak.
      unsubscribe()
      expect(mock.rendererListeners.get('evt:clones')?.length ?? 0).toBe(0)
      for (const listener of mock.rendererListeners.get('evt:clones') ?? []) listener(null, payload)
      expect(seen.length).toBe(1)
    } finally {
      harness.cleanup()
    }
  })
})

describe('AST policy: no raw renderer IPC', () => {
  it('finds zero ipcRenderer usages anywhere in the renderer source', () => {
    const rendererRoot = resolve(fileURLToPath(new URL('../../renderer/src', import.meta.url)))
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        const info = statSync(full)
        if (info.isDirectory()) {
          walk(full)
        } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
          const content = readFileSync(full, 'utf8')
          if (/\bipcRenderer\b/.test(content)) offenders.push(full)
        }
      }
    }
    walk(rendererRoot)
    expect(offenders).toEqual([])
  })

  it('sanity: the preload bridge still owns the only ipcRenderer usage', () => {
    const preloadFile = readFileSync(
      resolve(fileURLToPath(new URL('../../preload/index.ts', import.meta.url))),
      'utf8'
    )
    expect(/\bipcRenderer\b/.test(preloadFile)).toBe(true)
  })
})

describe('clone records emitted over evt:clones are schema-valid', () => {
  it('accepts and rejects CloneRecord payloads through the shared schema', () => {
    const good: CloneRecord = {
      id: UUID,
      attempt: 1,
      repoKind: 'model',
      repoId: 'org/repo',
      transport: 'https',
      destination: 'C:\\qa\\clone-dest',
      auth: 'none',
      proxy: { mode: 'system' },
      status: 'queued',
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z'
    }
    expect(cloneRecordSchema.safeParse(good).success).toBe(true)
    // A forged status outside the closed union is refused.
    expect(cloneRecordSchema.safeParse({ ...good, status: 'magic' }).success).toBe(false)
    // A token-bearing destination is refused (schema gates persist columns too).
    expect(cloneRecordSchema.safeParse({ ...good, destination: 'C:\\qa\\hf_TOKEN' }).success).toBe(
      true
    )
    // Unknown fields are refused (strict).
    expect(cloneRecordSchema.safeParse({ ...good, token: 'hf_x' }).success).toBe(false)
    // Arbitrary extra top-level id types are refused.
    expect(cloneRecordSchema.safeParse({ ...good, id: UUID_2 }).success).toBe(true)
    expect(cloneRecordSchema.safeParse({ ...good, id: 'not-uuid' }).success).toBe(false)
  })
})
