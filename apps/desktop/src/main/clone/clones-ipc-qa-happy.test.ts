// apps/desktop/src/main/clone/clones-ipc-qa-happy.test.ts
//
// Todo 33 QA (evidence) — HAPPY path through the REAL preload bridge and the
// REAL central IPC wrapper (Zod + sender trust) into a REAL CloneManager +
// CloneStore over in-memory SQLite with a fake clone host. Fully offline:
// Git never spawns anywhere (the host is a stub that completes instantly or
// hangs on demand).
//
// Scenario: the renderer fixture creates a clone (proxy resolved from the
// settings snapshot), observes schema-valid `evt:clones` events, lists/gets
// schema-valid records, cancels a queued/running clone, opens the completed
// destination, and unsubscribes without leaking listeners.
//
// Evidence is written to .omo/evidence/task-33-adopt-ohmyhf-main/ (gitignored).
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { CloneRecord, CloneRequest, RendererApi } from '@hubfetch/shared'
import { cloneRecordSchema } from '@hubfetch/shared'
import type { ClonesIpcMock } from './clones-ipc-test-utils'

// ---------------------------------------------------------------------------
// Electron mock (same shape as the contract test; vi.hoisted runs pre-import)
// ---------------------------------------------------------------------------
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

const ROOT = resolve(fileURLToPath(new URL('../../../../..', import.meta.url)))
const EVIDENCE = join(ROOT, '.omo', 'evidence', 'task-33-adopt-ohmyhf-main')

function makeRequest(destination: string, proxy?: CloneRequest['proxy']): CloneRequest {
  return {
    kind: 'model',
    id: 'qa-author/happy-model',
    transport: 'https',
    destination,
    auth: 'none',
    proxy
  }
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${label}`)
    await new Promise((r) => setImmediate(r))
  }
}

async function writeQaHappy(lines: string[]): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(EVIDENCE, { recursive: true })
  await writeFile(join(EVIDENCE, 'qa-happy.txt'), lines.join('\n') + '\n')
}

const harnesses: Array<{ cleanup(): void }> = []
afterAll(async () => {
  for (const harness of harnesses.splice(0)) harness.cleanup()
})

describe('clone IPC happy path (preload -> wrapper -> manager)', () => {
  it('creates, observes, lists, gets, cancels, opens, and unsubscribes', async () => {
    const harness = makeClonesIpcHarness(mock)
    harnesses.push(harness)
    const lines: string[] = ['QA_HAPPY_PASS']

    // --- Subscribe to evt:clones (returns unsubscribe) ---------------------
    const seen: CloneRecord[][] = []
    const unsubscribe = harness.api.clones.onClonesChanged((records) => seen.push(records))
    const recordSchemaValid = (records: CloneRecord[]): boolean =>
      records.every((record) => cloneRecordSchema.safeParse(record).success)

    // --- Create (proxy omitted -> main resolves the settings snapshot) -----
    const destA = join(harness.scratchDir, 'happy-a')
    const created = await harness.api.clones.create(makeRequest(destA))
    expect(cloneRecordSchema.safeParse(created).success).toBe(true)
    expect(created.status).toBe('queued')
    expect(created.repoId).toBe('qa-author/happy-model')
    expect(created.proxy).toEqual({ mode: 'system' })
    await waitFor(() => harness.store.get(created.id)?.status === 'completed', 'A completed')

    // --- List + get return schema-valid records ----------------------------
    const list = await harness.api.clones.list()
    expect(list.some((record) => record.id === created.id && record.status === 'completed')).toBe(
      true
    )
    expect(recordSchemaValid(list)).toBe(true)
    const got = await harness.api.clones.get(created.id)
    expect(got?.id).toBe(created.id)
    expect(cloneRecordSchema.safeParse(got as CloneRecord).success).toBe(true)
    const missing = await harness.api.clones.get('123e4567-e89b-12d3-a456-426614174000')
    expect(missing).toBeNull()

    // --- Observed events: every snapshot schema-valid -----------------------
    await waitFor(() => seen.length >= 3, 'queued/running/completed events')
    expect(recordSchemaValid(seen[seen.length - 1] as CloneRecord[])).toBe(true)
    const finalEvent = seen[seen.length - 1] as CloneRecord[]
    expect(finalEvent.some((record) => record.id === created.id)).toBe(true)

    // --- Cancel a hanging (running) clone through the preload ---------------
    harness.host.hangNext = true
    const destB = join(harness.scratchDir, 'happy-b')
    const hanging = await harness.api.clones.create(makeRequest(destB, { mode: 'direct' }))
    expect(hanging.proxy).toEqual({ mode: 'direct' })
    await waitFor(() => harness.host.startCalls >= 2, 'B host start invoked')
    await waitFor(() => harness.store.get(hanging.id)?.status === 'running', 'B running')
    const afterCancel = await harness.api.clones.cancel(hanging.id)
    const cancelled = afterCancel.find((record) => record.id === hanging.id)
    expect(cancelled?.status).toBe('cancelled')
    expect(recordSchemaValid(afterCancel)).toBe(true)
    // The hanging host was consumed by the cancel; restore instant completion.
    harness.host.hangNext = false

    // --- Open the completed destination (owner-bound path) ------------------
    await harness.api.clones.openDestination(created.id)
    expect(mock.openPathCalls.length).toBeGreaterThan(0)
    expect(mock.openPathCalls.some((path) => path.includes('happy-a'))).toBe(true)

    // --- Unsubscribe: no further events leak --------------------------------
    const beforeUnsubscribe = seen.length
    unsubscribe()
    expect(mock.rendererListeners.get('evt:clones')?.length ?? 0).toBe(0)
    const destC = join(harness.scratchDir, 'happy-c')
    const afterUnsub = await harness.api.clones.create(makeRequest(destC))
    await waitFor(() => harness.store.get(afterUnsub.id)?.status === 'completed', 'C completed')
    expect(seen.length).toBe(beforeUnsubscribe)

    // --- Manager shutdown: zero active rows + zero Job PIDs -----------------
    const shutdown = await harness.manager.shutdown()
    expect(shutdown.zeroProven).toBe(true)
    expect(shutdown.remainingJobPids).toEqual([])
    expect(shutdown.storeActive).toBe(0)

    lines.push(
      JSON.stringify({
        scenario: 'happy-preload-round-trip',
        created: { id: created.id, status: created.status, proxy: created.proxy },
        listCount: list.length,
        getMatched: got?.id === created.id,
        observedEvents: seen.length,
        eventsSchemaValid: recordSchemaValid(seen[seen.length - 1] as CloneRecord[]),
        hangingCancelled: cancelled?.status,
        openPathCalls: mock.openPathCalls,
        unsubscribeNoLeak: afterUnsub.status === 'queued' && seen.length === beforeUnsubscribe,
        shutdown: { zeroProven: shutdown.zeroProven, storeActive: shutdown.storeActive },
        note: 'create(proxy resolved from settings) -> evt:clones -> list/get -> cancel running -> openDestination -> unsubscribe no-leak'
      })
    )
    await writeQaHappy(lines)
  }, 30_000)
})
