import type { CloneRecord, CloneRequest } from '@hubfetch/shared'

/**
 * Typed access to `window.hubfetch.clones.*` (plan Todo 33). Every call
 * delegates to the central validated IPC path in main — this namespace is a
 * convenience surface, never a sender-validation bypass.
 */

export function listClones(): Promise<CloneRecord[]> {
  return window.hubfetch.clones.list()
}

export function getClone(id: string): Promise<CloneRecord | null> {
  return window.hubfetch.clones.get(id)
}

export function createClone(request: CloneRequest): Promise<CloneRecord> {
  return window.hubfetch.clones.create(request)
}

export function cancelClone(id: string): Promise<CloneRecord[]> {
  return window.hubfetch.clones.cancel(id)
}

export function removeClone(id: string): Promise<CloneRecord[]> {
  return window.hubfetch.clones.remove(id)
}

export function retryClone(parentId: string, request: CloneRequest): Promise<CloneRecord> {
  return window.hubfetch.clones.retry(parentId, request)
}

export function openCloneDestination(id: string): Promise<void> {
  return window.hubfetch.clones.openDestination(id)
}

export function onClonesChanged(listener: (records: CloneRecord[]) => void): () => void {
  return window.hubfetch.clones.onClonesChanged(listener)
}
