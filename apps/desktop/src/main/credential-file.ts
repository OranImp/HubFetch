import { execFileSync } from 'node:child_process'
import { chmodSync, renameSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'

/**
 * On-disk credentials are written atomically and locked down to the current
 * user before they appear under their final name. A crash at any point leaves
 * either the previous valid file or the renamed complete file — never a
 * partial `credentials.json`, because readers only ever open the destination
 * name and the temp file carries a per-process suffix.
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
    // Drop every inherited ACE, then grant exactly the current account R/W.
    execFileSync(
      icaclsPath(),
      [file, '/inheritance:r', '/grant:r', `${userInfo().username}:(R,W)`],
      { stdio: 'ignore' }
    )
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
  deps.restrictDacl(tmp)
  deps.rename(tmp, file)
}
