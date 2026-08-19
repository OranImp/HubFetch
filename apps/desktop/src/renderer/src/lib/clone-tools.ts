import { CLONE_TOOLS, type CloneToolId } from '@hubfetch/shared'
import { openExternal } from './ipc'

/**
 * Guided-open dispatcher: looks up the shared clone-tools catalog and opens
 * the official HTTPS download page. Opens a page only — never invokes an
 * install channel and never spawns a process.
 */
export function performCloneToolInstall(id: CloneToolId): void {
  openExternal(CLONE_TOOLS[id].installUrl)
}