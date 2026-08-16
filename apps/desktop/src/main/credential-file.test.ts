import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { restrictDaclToCurrentUser, writeCredentialsFileAtomic } from './credential-file'

const roots: string[] = []

function newRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true })
    expect(existsSync(root)).toBe(false)
  }
})

describe('atomic credentials write: restricted DACL must not break the rename', () => {
  // Regression: `restrictDaclToCurrentUser` dropped every inherited ACE with
  // `/inheritance:r` and granted only (R,W). On E-drive NTFS temp directories
  // that left the temp file without the DELETE right, so `renameSync` (which
  // needs DELETE on the source file) threw EPERM and the credentials file could
  // never be atomically updated. The grant must include DELETE/Full Control.
  it.skipIf(process.platform !== 'win32')(
    'renames the temp file into place after the DACL is restricted to the current user',
    () => {
      const dir = newRoot('hubfetch-credential-rename-')
      const tmp = join(dir, 'credentials.json.9999.tmp')
      const final = join(dir, 'credentials.json')
      writeFileSync(tmp, '{"version":1,"cipher":"DACL-RENAME-PROBE"}', { mode: 0o600 })

      // This is exactly the sequence writeCredentialsFileAtomic performs:
      // restrict the temp file's DACL to the current user, then atomically move
      // it under the final name.
      restrictDaclToCurrentUser(tmp)
      expect(() => renameSync(tmp, final)).not.toThrow()
      expect(readFileSync(final, 'utf8')).toBe('{"version":1,"cipher":"DACL-RENAME-PROBE"}')
    }
  )

  it('degrades to write+rename when the DACL restriction fails', () => {
    const dir = newRoot('hubfetch-credential-dacl-fail-')
    const final = join(dir, 'credentials.json')
    const failingDeps = {
      writeFile: (f: string, d: string, o: { mode: number }) => writeFileSync(f, d, o),
      rename: (from: string, to: string) => renameSync(from, to),
      restrictDacl: () => {
        throw new Error('icacls unavailable')
      },
      pid: 31337
    }
    // A failed DACL lockdown (e.g. icacls missing on a future platform) must
    // never break the atomic write: the temp file then keeps the parent's
    // inherited ACL (which still grants the rename right).
    expect(() =>
      writeCredentialsFileAtomic(final, '{"version":1,"cipher":"NO-DACL"}', failingDeps)
    ).not.toThrow()
    expect(readFileSync(final, 'utf8')).toBe('{"version":1,"cipher":"NO-DACL"}')
  })
})
