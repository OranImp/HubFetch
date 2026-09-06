import { describe, expect, expectTypeOf, it, vi, beforeEach } from 'vitest'
import type { DatasetExportPageResult, IpcResponse } from '@hubfetch/shared'
import { IPC_INVOKE_CHANNELS, ipcRequestSchemas } from '@hubfetch/shared'
import { registerIpcHandlers, type AppContext } from './ipc'
import { makeRogueEvent, PACKAGED_ENTRY } from './clone/clones-ipc-test-utils'

interface MockContainer {
  handlers: Map<string, (event: unknown, payload: unknown) => unknown>
  trustedUrl: string
  saveDialog: { canceled: boolean; filePath?: string }
  written: Array<{ path: string; contents: string }>
}

const mock: MockContainer = vi.hoisted(() => ({
  handlers: new Map(),
  trustedUrl: 'file:///E:/Apps/HubFetch/resources/app.asar/out/renderer/index.html',
  saveDialog: { canceled: true as const },
  written: [] as Array<{ path: string; contents: string }>
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
        if (!handler) return Promise.reject(new Error(`no handler ${channel}`))
        return Promise.resolve(handler(trustedEvent(), payload))
      }
    },
    contextBridge: { exposeInMainWorld: () => undefined },
    BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => mock.saveDialog
    },
    shell: {
      openExternal: async () => undefined,
      openPath: async () => '',
      showItemInFolder: () => undefined
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value, 'utf8'),
      decryptString: (buffer: Buffer) => buffer.toString('utf8')
    },
    net: { isOnline: () => true },
    Notification: class {},
    Menu: {
      buildFromTemplate: () => ({ popup: () => undefined, append: () => undefined }),
      setApplicationMenu: () => undefined
    },
    Tray: class {},
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }) }
  }
})

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    writeFile: async (path: string, contents: string) => {
      mock.written.push({ path, contents })
    },
    rename: async () => undefined,
    rm: async () => undefined
  }
})

const VALID = {
  repoId: 'owner/ds',
  config: 'default',
  split: 'train',
  offset: 25,
  length: 25,
  format: 'csv' as const
}

function trustedEvent(): unknown {
  const frame = {}
  return {
    sender: { id: 7, getURL: () => mock.trustedUrl, mainFrame: frame },
    senderFrame: frame
  }
}

function invoke(payload: unknown, event: unknown = trustedEvent()): Promise<unknown> {
  const handler = mock.handlers.get('dataset:exportPage')
  if (!handler) throw new Error('dataset:exportPage was not registered')
  return Promise.resolve(handler(event, payload))
}

const getDatasetRows = vi.fn(async () => ({
  columns: ['text'],
  rows: [['hi']],
  values: [['你好']]
}))

function register(): void {
  mock.handlers.clear()
  registerIpcHandlers(
    {
      hub: { getDatasetRows },
      auth: { getState: () => ({ status: 'signedOut' }) },
      db: {},
      settings: { get: () => ({ hubEndpoint: null, proxy: { mode: 'system' } }) },
      library: {},
      downloads: {},
      cache: {},
      follows: {},
      integrationTasks: {},
      i18n: {},
      rebuildMenu: () => undefined,
      notificationRegistration: {},
      removeNotificationShortcut: () => false,
      broadcast: () => undefined,
      applyNetworkSettings: async () => undefined,
      applyDesktopSettings: () => undefined,
      diagnostics: {},
      clones: {},
      llmCredentials: {},
      llmService: {}
    } as unknown as AppContext,
    { packagedEntry: PACKAGED_ENTRY, devOrigin: null }
  )
}

describe('dataset:exportPage IPC', () => {
  beforeEach(() => {
    getDatasetRows.mockClear()
    mock.written = []
    mock.saveDialog = { canceled: true }
    register()
  })

  it('is on the invoke allowlist and types the result', () => {
    expect(IPC_INVOKE_CHANNELS).toContain('dataset:exportPage')
    expectTypeOf<IpcResponse<'dataset:exportPage'>>().toEqualTypeOf<DatasetExportPageResult>()
  })

  it('rejects length > 100, malformed format/offset/config/split, and renderer rows', async () => {
    const schema = ipcRequestSchemas['dataset:exportPage']!
    expect(schema.safeParse({ ...VALID, length: 101 }).success).toBe(false)
    await expect(invoke({ ...VALID, length: 101 })).rejects.toThrow(/Invalid payload/)
    await expect(invoke({ ...VALID, format: 'xlsx' })).rejects.toThrow(/Invalid payload/)
    await expect(invoke({ ...VALID, offset: -4 })).rejects.toThrow(/Invalid payload/)
    await expect(invoke({ ...VALID, config: '' })).rejects.toThrow(/Invalid payload/)
    await expect(invoke({ ...VALID, split: '..' })).rejects.toThrow(/Invalid payload/)
    await expect(invoke({ ...VALID, rows: [['nope']] })).rejects.toThrow(/Invalid payload/)
    expect(getDatasetRows).not.toHaveBeenCalled()
  })

  it('rejects an untrusted sender before any Hub fetch', async () => {
    await expect(invoke(VALID, makeRogueEvent())).rejects.toThrow(/IPC sender rejected/)
    expect(getDatasetRows).not.toHaveBeenCalled()
  })

  it('cancels without writing a final file', async () => {
    mock.saveDialog = { canceled: true }
    const result = await invoke(VALID)
    expect(result).toEqual({ status: 'canceled' })
    expect(getDatasetRows).toHaveBeenCalledWith('owner/ds', 'default', 'train', 25, 25)
    expect(mock.written).toEqual([])
  })
})
