// apps/desktop/src/main/clone/clones-ipc-qa-failure.test.ts
//
// Todo 33 QA (evidence) — FAILURE path through the REAL preload bridge and the
// REAL central IPC wrapper (Zod + sender trust) into a REAL CloneManager.
//
// Scenario: raw URL / token / forged status / unknown field / oversized
// values / credential-bearing proxy / non-UUID ids / unknown channel / rogue
// sender frame are ALL rejected with ZERO clone-manager calls. The manager
// never sees a byte of a rejected payload.
//
// Evidence is written to .omo/evidence/task-33-adopt-ohmyhf-main/ (gitignored).
import { join, resolve } from 'node:path'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { CloneRequest, RendererApi } from '@hubfetch/shared'
import type { ClonesIpcMock } from './clones-ipc-test-utils'
import { makeRogueEvent, PACKAGED_ENTRY } from './clones-ipc-test-utils'

// ---------------------------------------------------------------------------
// Electron mock (same shape as the contract/happy tests)
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
      showOpenDialog: async () => {
        mock.showOpenDialogCalls = (mock.showOpenDialogCalls ?? 0) + 1
        return mock.showOpenDialogResult ?? { canceled: true, filePaths: [] }
      },
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

function makeRequest(): CloneRequest {
  return {
    kind: 'model',
    id: 'qa-author/failure-model',
    transport: 'https',
    destination: join('C:\\qa\\clone-failure-dest'),
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

async function writeQaFailure(lines: string[]): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(EVIDENCE, { recursive: true })
  await writeFile(join(EVIDENCE, 'qa-failure.txt'), lines.join('\n') + '\n')
}

const harnesses: Array<{ cleanup(): void }> = []
afterAll(async () => {
  for (const harness of harnesses.splice(0)) harness.cleanup()
})

describe('clone IPC failure path (reject before the manager)', () => {
  it('rejects raw url/token/forged status/unknown/oversized/channel/rogue frame with zero manager calls', async () => {
    const harness = makeClonesIpcHarness(mock)
    harnesses.push(harness)
    const lines: string[] = ['QA_FAILURE_PASS']
    const probes: unknown[] = []

    const createSpy = vi.spyOn(harness.manager, 'create')
    const retrySpy = vi.spyOn(harness.manager, 'retry')
    const cancelSpy = vi.spyOn(harness.manager, 'cancel')
    const listSpy = vi.spyOn(harness.manager, 'list')
    const removeSpy = vi.spyOn(harness.manager, 'remove')

    const expectRejected = async (promise: Promise<unknown>, label: string): Promise<void> => {
      await expect(promise).rejects.toThrow()
      probes.push({ label, rejected: true })
    }

    // --- Through the PRELOAD bridge (nested fields) --------------------------
    await expectRejected(
      harness.api.clones.create({ ...makeRequest(), url: 'https://evil.example/x.git' } as never),
      'create-raw-url-nested'
    )
    await expectRejected(
      harness.api.clones.create({ ...makeRequest(), token: 'hf_abc123' } as never),
      'create-token-nested'
    )
    await expectRejected(
      harness.api.clones.create({ ...makeRequest(), status: 'completed' } as never),
      'create-forged-status'
    )
    await expectRejected(
      harness.api.clones.create({
        ...makeRequest(),
        proxy: { mode: 'manual', url: 'http://user:pass@127.0.0.1:7897' }
      } as never),
      'create-credential-proxy'
    )
    await expectRejected(
      harness.api.clones.create({
        ...makeRequest(),
        destination: 'x'.repeat(1025)
      } as never),
      'create-oversized-destination'
    )
    await expectRejected(
      harness.api.clones.create({
        ...makeRequest(),
        revision: { kind: 'branch', name: '-evil' }
      } as never),
      'create-option-injection-revision'
    )
    await expectRejected(
      harness.api.clones.retry('not-a-uuid', makeRequest()),
      'retry-bad-parent-id'
    )
    await expectRejected(harness.api.clones.cancel('not-a-uuid'), 'cancel-bad-id')
    await expectRejected(harness.api.clones.get('f'.repeat(36)), 'get-bad-id')
    await expectRejected(harness.api.clones.openDestination('not-a-uuid'), 'open-bad-id')
    // Malformed remove id: the UUID schema rejects it BEFORE the manager.
    await expectRejected(harness.api.clones.remove('not-a-uuid'), 'remove-bad-id')

    // --- Unknown channel through the preload invoke ---------------------------
    await expectRejected(
      harness.api.invoke('clones:banish' as never, undefined as never),
      'unknown-channel'
    )

    // --- Top-level smuggled fields through the RAW handler (trusted sender) ---
    const frame = {}
    const trusted = {
      sender: { id: 7, getURL: () => PACKAGED_ENTRY, mainFrame: frame },
      senderFrame: frame
    }
    const createHandler = mock.handlers.get('clones:create') as (e: unknown, p: unknown) => unknown
    await expectRejected(
      Promise.resolve(createHandler(trusted, { request: makeRequest(), token: 'hf_top_level' })),
      'create-top-level-token'
    )
    await expectRejected(
      Promise.resolve(createHandler(trusted, { request: makeRequest(), url: 'https://x.git' })),
      'create-top-level-url'
    )
    const listHandler = mock.handlers.get('clones:list') as (e: unknown, p: unknown) => unknown
    await expectRejected(
      Promise.resolve(listHandler(trusted, { id: '123e4567-e89b-12d3-a456-426614174000' })),
      'list-rejects-payload'
    )
    // selectDestination is a void-request channel: any payload is rejected
    // before the dialog is ever opened.
    const selectHandler = mock.handlers.get('clones:selectDestination') as (
      e: unknown,
      p: unknown
    ) => unknown
    await expectRejected(
      Promise.resolve(selectHandler(trusted, { path: 'C:\\qa\\smuggled' })),
      'select-rejects-payload'
    )

    // --- Rogue sender frame through the RAW handler ---------------------------
    const rogue = makeRogueEvent('https://evil.example/')
    await expectRejected(
      Promise.resolve(createHandler(rogue, { request: makeRequest() })),
      'rogue-frame-create'
    )
    await expectRejected(Promise.resolve(listHandler(rogue, undefined)), 'rogue-frame-list')

    // --- Zero manager calls across every rejected probe ------------------------
    expect(createSpy).not.toHaveBeenCalled()
    expect(retrySpy).not.toHaveBeenCalled()
    expect(cancelSpy).not.toHaveBeenCalled()
    expect(listSpy).not.toHaveBeenCalled()
    expect(removeSpy).not.toHaveBeenCalled()
    expect(harness.store.list().length).toBe(0)

    lines.push(
      JSON.stringify({
        scenario: 'failure-reject-before-manager',
        probeCount: probes.length,
        probes,
        managerCalls: {
          create: createSpy.mock.calls.length,
          retry: retrySpy.mock.calls.length,
          cancel: cancelSpy.mock.calls.length,
          list: listSpy.mock.calls.length,
          remove: removeSpy.mock.calls.length
        },
        storedRows: harness.store.list().length,
        note: 'every invalid/unknown/oversized/hostile payload rejected by Zod or sender trust BEFORE CloneManager; zero manager calls'
      })
    )
    await writeQaFailure(lines)
  }, 30_000)

  it('rejects active-row (running) removal without mutation', async () => {
    const harness = makeClonesIpcHarness(mock)
    harnesses.push(harness)
    const lines: string[] = []

    // A hanging host keeps the row RUNNING so the remove path must refuse it.
    harness.host.hangNext = true
    const created = await harness.api.clones.create({
      kind: 'model',
      id: 'qa-author/active-remove',
      transport: 'https',
      destination: join(harness.scratchDir, 'active-remove-dest'),
      auth: 'none',
      proxy: { mode: 'system' }
    })
    await waitFor(() => harness.store.get(created.id)?.status === 'running', 'active running')
    const before = harness.store.list()
    await expect(harness.api.clones.remove(created.id)).rejects.toThrow()
    const after = harness.store.list()
    // Zero mutation: same length, same running status, no worker cancel.
    expect(after.length).toBe(before.length)
    expect(after.find((record) => record.id === created.id)?.status).toBe('running')
    expect(harness.host.cancelClone).not.toHaveBeenCalled()

    // Cleanup: let the cancel protocol terminalize the hanging attempt.
    harness.host.hangNext = false
    const afterCancel = await harness.api.clones.cancel(created.id)
    expect(afterCancel.find((record) => record.id === created.id)?.status).toBe('cancelled')

    lines.push(
      JSON.stringify({
        scenario: 'failure-active-remove',
        rejected: true,
        id: created.id,
        statusBefore: before.find((record) => record.id === created.id)?.status,
        statusAfter: after.find((record) => record.id === created.id)?.status,
        listLength: { before: before.length, after: after.length },
        hostCancelCalled: harness.host.cancelClone.mock.calls.length,
        note: 'active (running) removal rejected by the store with zero mutation and no host cancel'
      })
    )
    await writeQaFailure(lines)
  }, 30_000)

  it('rejects a FILE selection with a sanitized error', async () => {
    const harness = makeClonesIpcHarness(mock)
    harnesses.push(harness)
    const lines: string[] = []

    const filePath = join(harness.scratchDir, 'picked-file.txt')
    await writeFile(filePath, 'not a directory', 'utf8')
    mock.showOpenDialogResult = { canceled: false, filePaths: [filePath] }
    await expect(harness.api.clones.selectDestination()).rejects.toThrow(
      /Selected clone destination is not a regular directory/
    )
    // The picker rejects without touching any clone state.
    expect(harness.store.list().length).toBe(0)

    lines.push(
      JSON.stringify({
        scenario: 'failure-file-selection',
        rejected: true,
        selected: filePath,
        storeRows: harness.store.list().length,
        note: 'a FILE selection is rejected with the sanitized regular-directory error'
      })
    )
    await writeQaFailure(lines)
  }, 30_000)

  it('rejects a SYMLINK selection', async () => {
    const harness = makeClonesIpcHarness(mock)
    harnesses.push(harness)
    const lines: string[] = []

    const target = join(harness.scratchDir, 'target-dir')
    await mkdir(target, { recursive: true })
    const link = join(harness.scratchDir, 'linked-dir')
    // 'junction' needs no privilege on Windows and is ignored on POSIX; lstat
    // reports it as a symbolic link either way.
    await symlink(target, link, 'junction')
    mock.showOpenDialogResult = { canceled: false, filePaths: [link] }
    await expect(harness.api.clones.selectDestination()).rejects.toThrow(
      /Selected clone destination is not a regular directory/
    )
    expect(harness.store.list().length).toBe(0)

    lines.push(
      JSON.stringify({
        scenario: 'failure-symlink-selection',
        rejected: true,
        selected: link,
        storeRows: harness.store.list().length,
        note: 'a symlink/junction selection is rejected; only regular directories pass'
      })
    )
    await writeQaFailure(lines)
  }, 30_000)

  it('rejects a rogue sender before manager.remove and showOpenDialog', async () => {
    const harness = makeClonesIpcHarness(mock)
    harnesses.push(harness)
    const lines: string[] = []

    const removeSpy = vi.spyOn(harness.manager, 'remove')
    const rogue = makeRogueEvent()
    const removeHandler = mock.handlers.get('clones:remove') as (e: unknown, p: unknown) => unknown
    await expect(
      Promise.resolve(removeHandler(rogue, { id: '123e4567-e89b-12d3-a456-426614174000' }))
    ).rejects.toThrow(/IPC sender rejected/)
    expect(removeSpy).not.toHaveBeenCalled()

    const selectHandler = mock.handlers.get('clones:selectDestination') as (
      e: unknown,
      p: unknown
    ) => unknown
    const dialogCallsBefore = mock.showOpenDialogCalls ?? 0
    await expect(Promise.resolve(selectHandler(rogue, undefined))).rejects.toThrow(
      /IPC sender rejected/
    )
    expect(mock.showOpenDialogCalls ?? 0).toBe(dialogCallsBefore)
    expect(harness.store.list().length).toBe(0)

    lines.push(
      JSON.stringify({
        scenario: 'failure-rogue-sender',
        removeRejected: true,
        selectRejected: true,
        removeManagerCalls: removeSpy.mock.calls.length,
        showOpenDialogCalls: { before: dialogCallsBefore, after: mock.showOpenDialogCalls ?? 0 },
        storeRows: harness.store.list().length,
        note: 'rogue sender rejected BEFORE manager.remove and BEFORE showOpenDialog (zero service invocations)'
      })
    )
    await writeQaFailure(lines)
  }, 30_000)
})
