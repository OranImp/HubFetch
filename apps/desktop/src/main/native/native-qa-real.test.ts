// apps/desktop/src/main/native/native-qa-real.test.ts
//
// Todo 25 QA: the REAL Electron-ABI addon (built by `pnpm native:build`, ABI
// 148) under the system-Node vitest runtime (ABI 137). This is a genuine
// ABI-mismatch in the reverse direction: the loader must return the typed
// `wrong-abi` unavailable bridge and keep clone support disabled — never throw,
// never crash the process. Skipped when the staged addon is absent so the
// frozen-install gates stay green on a fresh checkout without a native build.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { getCloneSupport, loadHubFetchJob } from './hubfetch-job-loader'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => 'C:\\dev\\apps\\desktop'
  }
}))

const stagedAddon = join(
  __dirname,
  '..',
  '..',
  '..',
  'native',
  'windows',
  'build',
  'Release',
  'hubfetch_job.node'
)
const hasStagedAddon = existsSync(stagedAddon)

describe.skipIf(!hasStagedAddon)('real Electron-ABI addon under the Node runtime (vitest)', () => {
  it('classifies the ABI mismatch as typed wrong-abi', () => {
    const bridge = loadHubFetchJob({ overridePath: stagedAddon, checkExists: existsSync })
    expect(bridge.status).toBe('unavailable')
    if (bridge.status === 'unavailable') {
      expect(bridge.code).toBe('wrong-abi')
      expect(bridge.detail).toContain('NODE_MODULE_VERSION')
    }
  })

  it('keeps clone support disabled without throwing', () => {
    const bridge = loadHubFetchJob({ overridePath: stagedAddon, checkExists: existsSync })
    expect(() => getCloneSupport(bridge)).not.toThrow()
    expect(getCloneSupport(bridge)).toEqual({
      enabled: false,
      reason: 'hubfetch_job unavailable: wrong-abi'
    })
  })
})
