import { contextBridge, ipcRenderer } from 'electron'
import type {
  CloneBridge,
  CloneRecord,
  CloneRequest,
  CompatibilityBridge,
  DiagnosticReport,
  DiagnosticsBridge,
  DiagnosticsExportResult,
  DiagnosticsProgress,
  IpcEventChannel,
  IpcEventPayload,
  IpcInvokeChannel,
  IpcRequest,
  IpcResponse,
  HubCapabilityKey,
  HubCapabilityStatus,
  RendererApi
} from '@hubfetch/shared'
import { IPC_EVENT_CHANNELS, IPC_INVOKE_CHANNELS } from '@hubfetch/shared'

const invokeChannels = new Set<string>(IPC_INVOKE_CHANNELS)
const eventChannels = new Set<string>(IPC_EVENT_CHANNELS)

const diagnosticsBridge: DiagnosticsBridge = {
  run(): Promise<DiagnosticReport> {
    return ipcRenderer.invoke('diagnostics:run') as Promise<DiagnosticReport>
  },
  cancel(): Promise<void> {
    return ipcRenderer.invoke('diagnostics:cancel') as Promise<void>
  },
  exportBundle(): Promise<DiagnosticsExportResult> {
    return ipcRenderer.invoke('diagnostics:export') as Promise<DiagnosticsExportResult>
  },
  cancelExport(): Promise<void> {
    return ipcRenderer.invoke('diagnostics:exportCancel') as Promise<void>
  },
  onProgress(listener: (progress: DiagnosticsProgress) => void): () => void {
    const wrapped = (_event: unknown, payload: DiagnosticsProgress): void => listener(payload)
    ipcRenderer.on('evt:diagnosticsProgress', wrapped)
    return () => {
      ipcRenderer.removeListener('evt:diagnosticsProgress', wrapped)
    }
  }
}

/**
 * Typed clone bridge (plan Todo 33). Every method is named and narrow — no raw
 * channel/URL/path acceptance, no token bytes, no status writes. All payloads
 * are validated again in main (Zod + sender trust) before the manager runs.
 */
const cloneBridge: CloneBridge = {
  list(): Promise<CloneRecord[]> {
    return ipcRenderer.invoke('clones:list') as Promise<CloneRecord[]>
  },
  get(id: string): Promise<CloneRecord | null> {
    return ipcRenderer.invoke('clones:get', { id }) as Promise<CloneRecord | null>
  },
  create(request: CloneRequest): Promise<CloneRecord> {
    return ipcRenderer.invoke('clones:create', { request }) as Promise<CloneRecord>
  },
  cancel(id: string): Promise<CloneRecord[]> {
    return ipcRenderer.invoke('clones:cancel', { id }) as Promise<CloneRecord[]>
  },
  retry(parentId: string, request: CloneRequest): Promise<CloneRecord> {
    return ipcRenderer.invoke('clones:retry', { parentId, request }) as Promise<CloneRecord>
  },
  openDestination(id: string): Promise<void> {
    return ipcRenderer.invoke('clones:openDestination', { id }) as Promise<void>
  },
  remove(id: string): Promise<CloneRecord[]> {
    return ipcRenderer.invoke('clones:remove', { id }) as Promise<CloneRecord[]>
  },
  selectDestination(): Promise<string | null> {
    return ipcRenderer.invoke('clones:selectDestination') as Promise<string | null>
  },
  onClonesChanged(listener: (records: CloneRecord[]) => void): () => void {
    const wrapped = (_event: unknown, payload: CloneRecord[]): void => listener(payload)
    ipcRenderer.on('evt:clones', wrapped)
    return () => {
      ipcRenderer.removeListener('evt:clones', wrapped)
    }
  }
}

const compatibilityBridge: CompatibilityBridge = {
  read(): Promise<HubCapabilityStatus[]> {
    return ipcRenderer.invoke('compatibility:read') as Promise<HubCapabilityStatus[]>
  },
  probe(key: HubCapabilityKey): Promise<HubCapabilityStatus> {
    return ipcRenderer.invoke('compatibility:probe', { key }) as Promise<HubCapabilityStatus>
  }
}

/**
 * The minimal, typed bridge. Only channels defined in the shared contract can be
 * invoked or subscribed to; everything else throws before touching IPC.
 */
const api: RendererApi = {
  invoke<C extends IpcInvokeChannel>(channel: C, req: IpcRequest<C>): Promise<IpcResponse<C>> {
    if (!invokeChannels.has(channel)) {
      return Promise.reject(new Error(`Unknown IPC channel: ${channel}`))
    }
    return ipcRenderer.invoke(channel, req) as Promise<IpcResponse<C>>
  },
  on<C extends IpcEventChannel>(
    channel: C,
    listener: (payload: IpcEventPayload<C>) => void
  ): () => void {
    if (!eventChannels.has(channel)) {
      throw new Error(`Unknown IPC event channel: ${channel}`)
    }
    const wrapped = (_event: unknown, payload: IpcEventPayload<C>): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  },
  diagnostics: diagnosticsBridge,
  compatibility: compatibilityBridge,
  clones: cloneBridge
}

contextBridge.exposeInMainWorld('hubfetch', api)
