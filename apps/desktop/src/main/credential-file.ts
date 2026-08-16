import { execFileSync } from 'node:child_process'
import { chmodSync, renameSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'

/**
 * On-disk credentials are written atomically and locked down to the current
 * user before they appear under their final name.
 *
 * ACL strategy: the temp file's DACL is replaced (all inheritance dropped) with
 * a grant to the current user only, including Full Control. The lockdown runs
 * on the TEMP file BEFORE the atomic rename, so the final `credentials.json`
 * never exists under its final name with a default (inherited, potentially
 * Everyone-readable) ACL. Full Control keeps the DELETE right on the temp file,
 * which `renameSync` requires on its source: the old `(R,W)` grant dropped
 * DELETE along with the inherited ACEs, so the rename threw EPERM on E-drive
 * NTFS temp directories (a C-drive temp tolerated it via its inherited ACL).
 *
 * Crash safety: a crash at any point leaves either the previous valid file or
 * the renamed complete file — never a partial `credentials.json`, because
 * readers only ever open the destination name and the temp file carries a
 * per-process suffix.
 *
 * Failure handling: the DACL lockdown is best-effort. If `icacls` is
 * unavailable or fails on a future platform, the atomic write still completes —
 * the temp file then keeps the parent's inherited ACL, which still grants the
 * rename right. The write must never be blocked by the lockdown step.
 */

export interface CredentialWriteDeps {
  writeFile: (file: string, data: string, options: { mode: number }) => void
  rename: (from: string, to: string) => void
  restrictDacl: (file: string) => void
  pid: number
}

function icaclsPath(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe')
}

/** Replace a file's DACL with a grant for the current user only. */
export function restrictDaclToCurrentUser(file: string): void {
  if (process.platform === 'win32') {
    // Drop every inherited ACE, then grant exactly the current account full
    // control. Full Control includes DELETE, which renameSync needs on the
    // source (and on any destination entry it replaces).
    execFileSync(icaclsPath(), [file, '/inheritance:r', '/grant:r', `${userInfo().username}:(F)`], {
      stdio: 'ignore'
    })
    return
  }
  try {
    chmodSync(file, 0o600)
  } catch {
    // Best-effort on filesystems without POSIX modes.
  }
}

/** Atomic, owner-only credentials write. See module doc above. */
export function writeCredentialsFileAtomic(
  file: string,
  payload: string,
  deps: CredentialWriteDeps = {
    writeFile: (f, d, o) => writeFileSync(f, d, o),
    rename: (from, to) => renameSync(from, to),
    restrictDacl: restrictDaclToCurrentUser,
    pid: process.pid
  }
): void {
  const tmp = `${file}.${deps.pid}.tmp`
  deps.writeFile(tmp, payload, { mode: 0o600 })
  try {
    deps.restrictDacl(tmp)
  } catch {
    // Best-effort lockdown: a DACL failure must never break the atomic write.
    // Without the lockdown the temp file keeps the parent's inherited ACL,
    // which still permits the rename.
  }
  deps.rename(tmp, file)
}
