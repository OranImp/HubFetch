// apps/desktop/src/main/native/hubfetch-job-loader.test.ts
//
// Todo 25 loader contract tests (TDD): dev / packaged / missing / wrong-arch /
// wrong-export / wrong-abi plus the typed unavailable contract. The real addon
// is never required here — vitest runs on system Node (ABI 137) and the addon
// is built for Electron (ABI 148); the native smoke test covers the real load
// under the Electron runtime (pnpm native:test).
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  classifyRuntimeInfo,
  getCloneSupport,
  loadHubFetchJob,
  resolveHubFetchJobPath,
  type HubFetchJobBridge,
  type HubFetchJobHandle
} from './hubfetch-job-loader'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => 'C:\\dev\\apps\\desktop'
  }
}))

const RUNTIME_MODULES = String(process.versions.modules)

function validHandle(): Record<string, unknown> {
  return {
    assignProcess: () => ({ ok: true }),
    containsProcess: () => ({ ok: true, contains: false }),
    activeProcessIds: () => ({ ok: true, pids: [] }),
    terminate: () => ({ ok: true }),
    waitForEmpty: () => Promise.resolve({ ok: true }),
    close: () => ({ ok: true })
  }
}

function validModule(nodeAbi = RUNTIME_MODULES, arch = 'x64'): Record<string, unknown> {
  return {
    addonName: 'hubfetch_job',
    getRuntimeInfo: () => ({
      addonName: 'hubfetch_job',
      addonVersion: '0.2.0',
      nodeAbi: Number(nodeAbi),
      arch,
      napiVersion: 8
    }),
    createKillOnCloseJob: () => validHandle(),
    createAskPassSession: () => ({ pipeName: 'HubFetchAskPass-qa', session: {} })
  }
}

describe('resolveHubFetchJobPath', () => {
  it('resolves the dev path under the app root', () => {
    expect(resolveHubFetchJobPath({ appPath: 'C:\\dev\\apps\\desktop' })).toEqual({
      path: 'C:\\dev\\apps\\desktop\\native\\windows\\build\\Release\\hubfetch_job.node',
      mode: 'dev'
    })
  })

  it('resolves the packaged path under resources/native', () => {
    expect(
      resolveHubFetchJobPath({ isPackaged: true, resourcesPath: 'C:\\pkg\\resources' })
    ).toEqual({
      path: 'C:\\pkg\\resources\\native\\hubfetch_job.node',
      mode: 'packaged'
    })
  })

  it('gives the override path precedence over every mode', () => {
    expect(
      resolveHubFetchJobPath({
        overridePath: 'D:\\qa\\wrong-abi.node',
        isPackaged: true,
        resourcesPath: 'C:\\pkg\\resources'
      })
    ).toEqual({ path: 'D:\\qa\\wrong-abi.node', mode: 'override' })
  })

  it('returns null when no mode can resolve a path', () => {
    expect(resolveHubFetchJobPath({ isPackaged: true })).toBeNull()
    expect(resolveHubFetchJobPath({})).toBeNull()
  })
})

describe('classifyRuntimeInfo', () => {
  it('accepts a matching ABI + x64 module', () => {
    const result = classifyRuntimeInfo(validModule(), RUNTIME_MODULES)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.runtimeInfo.nodeAbi).toBe(Number(RUNTIME_MODULES))
  })

  it('rejects a wrong-arch module with the typed code', () => {
    const result = classifyRuntimeInfo(validModule(RUNTIME_MODULES, 'ia32'), RUNTIME_MODULES)
    expect(result).toEqual({
      ok: false,
      code: 'wrong-arch',
      detail: 'addon arch=ia32, expected x64'
    })
  })

  it('rejects a wrong-abi module with the typed code', () => {
    const result = classifyRuntimeInfo(validModule('148'), RUNTIME_MODULES)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('wrong-abi')
      expect(result.detail).toContain('addon NODE_MODULE_VERSION=148')
    }
  })

  it('rejects a wrong addonName', () => {
    const result = classifyRuntimeInfo(
      { ...validModule(), addonName: 'other_addon' },
      RUNTIME_MODULES
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('bad-exports')
  })

  it('rejects missing exports', () => {
    expect(classifyRuntimeInfo({ addonName: 'hubfetch_job' }, RUNTIME_MODULES).ok).toBe(false)
    expect(
      classifyRuntimeInfo({ ...validModule(), getRuntimeInfo: undefined }, RUNTIME_MODULES).ok
    ).toBe(false)
  })
})

describe('loadHubFetchJob — happy paths', () => {
  it('returns a ready bridge for a matching dev addon (electron mocked)', () => {
    const bridge = loadHubFetchJob({
      isPackaged: false,
      appPath: 'C:\\dev\\apps\\desktop',
      checkExists: () => true,
      loadModule: () => validModule()
    })
    expect(bridge.status).toBe('ready')
    if (bridge.status === 'ready') {
      expect(bridge.addonPath).toContain('native\\windows\\build\\Release\\hubfetch_job.node')
      expect(bridge.runtimeInfo.arch).toBe('x64')
      expect(getCloneSupport(bridge)).toEqual({ enabled: true, reason: null })
    }
  })

  it('returns a ready bridge for a matching packaged addon', () => {
    const bridge = loadHubFetchJob({
      isPackaged: true,
      resourcesPath: 'C:\\pkg\\resources',
      checkExists: () => true,
      loadModule: () => validModule()
    })
    expect(bridge.status).toBe('ready')
    if (bridge.status === 'ready')
      expect(bridge.addonPath).toBe('C:\\pkg\\resources\\native\\hubfetch_job.node')
  })

  it('honors the override path (QA/verification seam)', () => {
    const bridge = loadHubFetchJob({
      overridePath: 'D:\\qa\\real.node',
      checkExists: () => true,
      loadModule: () => validModule()
    })
    expect(bridge.status).toBe('ready')
    if (bridge.status === 'ready') expect(bridge.addonPath).toBe('D:\\qa\\real.node')
  })
})

describe('loadHubFetchJob — typed unavailable contract (no throws)', () => {
  it('reports unsupported-platform off Windows', () => {
    const bridge = loadHubFetchJob({
      platform: 'linux',
      arch: 'x64',
      loadModule: () => validModule()
    })
    expect(bridge.status).toBe('unavailable')
    if (bridge.status === 'unavailable') {
      expect(bridge.code).toBe('unsupported-platform')
      expect(getCloneSupport(bridge)).toEqual({
        enabled: false,
        reason: 'hubfetch_job unavailable: unsupported-platform'
      })
    }
  })

  it('reports unsupported-platform on a non-x64 host', () => {
    const bridge = loadHubFetchJob({
      platform: 'win32',
      arch: 'ia32',
      loadModule: () => validModule()
    })
    expect(bridge.status).toBe('unavailable')
    if (bridge.status === 'unavailable') expect(bridge.code).toBe('unsupported-platform')
  })

  it('reports missing when the file does not exist', () => {
    const bridge = loadHubFetchJob({ checkExists: () => false, appPath: 'C:\\dev\\apps\\desktop' })
    expect(bridge.status).toBe('unavailable')
    if (bridge.status === 'unavailable') {
      expect(bridge.code).toBe('missing')
      expect(getCloneSupport(bridge)).toEqual({
        enabled: false,
        reason: 'hubfetch_job unavailable: missing'
      })
    }
  })

  it('classifies an ABI-mismatch loader error as wrong-abi', () => {
    const bridge = loadHubFetchJob({
      checkExists: () => true,
      appPath: 'C:\\dev\\apps\\desktop',
      loadModule: () => {
        throw new Error(
          'The module ... was compiled against a different Node.js version using NODE_MODULE_VERSION 148'
        )
      }
    })
    expect(bridge.status).toBe('unavailable')
    if (bridge.status === 'unavailable') {
      expect(bridge.code).toBe('wrong-abi')
      expect(getCloneSupport(bridge)).toEqual({
        enabled: false,
        reason: 'hubfetch_job unavailable: wrong-abi'
      })
    }
  })

  it('classifies a generic loader error as load-failed', () => {
    const bridge = loadHubFetchJob({
      checkExists: () => true,
      appPath: 'C:\\dev\\apps\\desktop',
      loadModule: () => {
        throw new Error('cannot open shared object file')
      }
    })
    expect(bridge.status).toBe('unavailable')
    if (bridge.status === 'unavailable') expect(bridge.code).toBe('load-failed')
  })

  it('classifies a wrong-arch module as unavailable and keeps clone disabled', () => {
    const bridge = loadHubFetchJob({
      checkExists: () => true,
      appPath: 'C:\\dev\\apps\\desktop',
      loadModule: () => validModule(RUNTIME_MODULES, 'ia32')
    })
    expect(bridge.status).toBe('unavailable')
    if (bridge.status === 'unavailable') {
      expect(bridge.code).toBe('wrong-arch')
      expect(getCloneSupport(bridge).enabled).toBe(false)
    }
  })

  it('classifies a wrong-export module (no createKillOnCloseJob) as bad-exports', () => {
    const bridge = loadHubFetchJob({
      checkExists: () => true,
      appPath: 'C:\\dev\\apps\\desktop',
      loadModule: () => ({ ...validModule(), createKillOnCloseJob: undefined })
    })
    expect(bridge.status).toBe('unavailable')
    if (bridge.status === 'unavailable') expect(bridge.code).toBe('bad-exports')
  })

  it('classifies a module without createAskPassSession as bad-exports (Todo 30)', () => {
    const bridge = loadHubFetchJob({
      checkExists: () => true,
      appPath: 'C:\\dev\\apps\\desktop',
      loadModule: () => {
        const mod = validModule()
        delete mod.createAskPassSession
        return mod
      }
    })
    expect(bridge.status).toBe('unavailable')
    if (bridge.status === 'unavailable') expect(bridge.code).toBe('bad-exports')
  })

  it('exposes createAskPassSession on the ready bridge (Todo 30)', () => {
    const bridge = loadHubFetchJob({
      checkExists: () => true,
      appPath: 'C:\\dev\\apps\\desktop',
      loadModule: () => validModule()
    })
    expect(bridge.status).toBe('ready')
    if (bridge.status === 'ready') {
      const created = bridge.createAskPassSession({
        token: Buffer.from('token'),
        username: 'hf_user',
        job: validHandle() as unknown as HubFetchJobHandle,
        ttlMs: 60000,
        promptLimit: 4,
        allowUsername: true,
        allowPassword: true
      })
      expect(created.pipeName).toBe('HubFetchAskPass-qa')
    }
  })

  it('never throws, whatever the module does', () => {
    const tricky: Array<() => unknown> = [
      () => null,
      () => 42,
      () => ({ addonName: 'x' }),
      () => validModule('999', 'arm64')
    ]
    for (const make of tricky) {
      const bridge: HubFetchJobBridge = loadHubFetchJob({
        checkExists: () => true,
        appPath: 'C:\\dev\\apps\\desktop',
        loadModule: make
      })
      expect(bridge.status).toBe('unavailable')
    }
  })

  it('keeps the app free of unhandled load errors (no crash path)', () => {
    // The loader must return, not rethrow, so a missing/wrong addon can never
    // crash the Electron main process.
    expect(() =>
      loadHubFetchJob({
        checkExists: () => true,
        appPath: join('C:', 'does-not-matter'),
        loadModule: () => validModule('148')
      })
    ).not.toThrow()
  })
})

describe('ready bridge — createJob (Todo 27)', () => {
  it('creates a real Job handle through the ready bridge', () => {
    const handle = validHandle()
    const bridge = loadHubFetchJob({
      checkExists: () => true,
      appPath: 'C:\\dev\\apps\\desktop',
      loadModule: () => ({ ...validModule(), createKillOnCloseJob: () => handle })
    })
    expect(bridge.status).toBe('ready')
    if (bridge.status === 'ready') {
      const created = bridge.createJob()
      expect(created.ok).toBe(true)
      if (created.ok) expect(created.handle).toBe(handle)
    }
  })

  it('returns a typed failure when createKillOnCloseJob throws', () => {
    const bridge = loadHubFetchJob({
      checkExists: () => true,
      appPath: 'C:\\dev\\apps\\desktop',
      loadModule: () => ({
        ...validModule(),
        createKillOnCloseJob: () => {
          throw new Error('boom')
        }
      })
    })
    expect(bridge.status).toBe('ready')
    if (bridge.status === 'ready') {
      const created = bridge.createJob()
      expect(created.ok).toBe(false)
      if (!created.ok) expect(created.code).toBe('HUBFETCH_JOB_CREATE_THREW')
    }
  })

  it('returns a typed failure for a malformed handle shape', () => {
    const bridge = loadHubFetchJob({
      checkExists: () => true,
      appPath: 'C:\\dev\\apps\\desktop',
      loadModule: () => ({ ...validModule(), createKillOnCloseJob: () => ({ nope: true }) })
    })
    expect(bridge.status).toBe('ready')
    if (bridge.status === 'ready') {
      const created = bridge.createJob()
      expect(created.ok).toBe(false)
      if (!created.ok) expect(created.code).toBe('HUBFETCH_JOB_BAD_EXPORTS')
    }
  })

  it('never throws even when the addon misbehaves', () => {
    const bridge = loadHubFetchJob({
      checkExists: () => true,
      appPath: 'C:\\dev\\apps\\desktop',
      loadModule: () => ({
        ...validModule(),
        createKillOnCloseJob: () => {
          throw new Error('boom')
        }
      })
    })
    expect(bridge.status).toBe('ready')
    if (bridge.status === 'ready') {
      expect(() => bridge.createJob()).not.toThrow()
    }
  })
})

describe('getCloneSupport — real-bridge probe (Todo 26)', () => {
  it('enables clone support only when createKillOnCloseJob returns a valid handle', () => {
    const bridge = loadHubFetchJob({
      checkExists: () => true,
      appPath: 'C:\\dev\\apps\\desktop',
      loadModule: () => validModule()
    })
    expect(bridge.status).toBe('ready')
    if (bridge.status === 'ready') {
      expect(getCloneSupport(bridge)).toEqual({ enabled: true, reason: null })
    }
  })

  it('keeps clone support disabled when createKillOnCloseJob throws', () => {
    const bridge = loadHubFetchJob({
      checkExists: () => true,
      appPath: 'C:\\dev\\apps\\desktop',
      loadModule: () => ({
        ...validModule(),
        createKillOnCloseJob: () => {
          const err = new Error('CreateJobObjectW failed') as Error & {
            code?: string
            errorCode?: string
          }
          err.code = 'HUBFETCH_JOB_CREATE_FAILED'
          err.errorCode = 'access-denied'
          throw err
        }
      })
    })
    expect(bridge.status).toBe('ready')
    if (bridge.status === 'ready') {
      const support = getCloneSupport(bridge)
      expect(support.enabled).toBe(false)
      expect(support.reason).toContain('HUBFETCH_JOB_CREATE_FAILED')
      expect(support.reason).toContain('access-denied')
    }
  })

  it('keeps clone support disabled for a malformed handle (stub / not-implemented shape)', () => {
    const bridge = loadHubFetchJob({
      checkExists: () => true,
      appPath: 'C:\\dev\\apps\\desktop',
      loadModule: () => ({
        ...validModule(),
        createKillOnCloseJob: () => ({ status: 'not-implemented' })
      })
    })
    expect(bridge.status).toBe('ready')
    if (bridge.status === 'ready') {
      const support = getCloneSupport(bridge)
      expect(support.enabled).toBe(false)
      expect(support.reason).toContain('HUBFETCH_JOB_BAD_EXPORTS')
    }
  })

  it('probe closes the throwaway Job handle it creates', () => {
    const closeSpy = vi.fn(() => ({ ok: true }))
    const bridge = loadHubFetchJob({
      checkExists: () => true,
      appPath: 'C:\\dev\\apps\\desktop',
      loadModule: () => ({
        ...validModule(),
        createKillOnCloseJob: () => ({ ...validHandle(), close: closeSpy })
      })
    })
    expect(bridge.status).toBe('ready')
    if (bridge.status === 'ready') {
      expect(getCloneSupport(bridge).enabled).toBe(true)
      expect(closeSpy).toHaveBeenCalledTimes(1)
    }
  })

  it('never throws even when the probe itself misbehaves', () => {
    const bridge = loadHubFetchJob({
      checkExists: () => true,
      appPath: 'C:\\dev\\apps\\desktop',
      loadModule: () => ({
        ...validModule(),
        createKillOnCloseJob: () => {
          throw new Error('boom')
        }
      })
    })
    expect(bridge.status).toBe('ready')
    if (bridge.status === 'ready') {
      expect(() => getCloneSupport(bridge)).not.toThrow()
      expect(getCloneSupport(bridge).enabled).toBe(false)
    }
  })
})
