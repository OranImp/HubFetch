// apps/desktop/src/main/native/hubfetch-job-loader.ts
//
// Todo 25: typed main-process loader for the `hubfetch_job` Windows x64
// Node-API addon. Resolves the dev and packaged paths, validates platform /
// ABI / architecture / export shape, and NEVER throws — it returns a typed
// bridge:
//
//   { status: 'ready', ... }        → safe to enable clone containment
//   { status: 'unavailable', code } → typed reason, clone support stays OFF
//
// Clone support MUST remain disabled while the bridge is unavailable or while
// createKillOnCloseJob returns the Todo 26 not-implemented stub — the Git
// containment layer (Todos 26/27) is gated behind `getCloneSupport()`.
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export const HUBFETCH_JOB_ADDON_NAME = 'hubfetch_job'
export const HUBFETCH_JOB_ADDON_FILENAME = 'hubfetch_job.node'
export const HUBFETCH_JOB_ADDON_PATH_OVERRIDE = 'HUBFETCH_JOB_ADDON_PATH'
export const HUBFETCH_JOB_ADDON_VERSION = '0.1.0'

export type HubFetchJobUnavailableCode =
  'unsupported-platform' | 'missing' | 'load-failed' | 'wrong-abi' | 'wrong-arch' | 'bad-exports'

/** Runtime probe returned by the addon's getRuntimeInfo(). */
export interface HubFetchJobRuntimeInfo {
  addonName: string
  addonVersion: string
  /** NODE_MODULE_VERSION baked at compile time (Electron 43.1.0 → 148). */
  nodeAbi: number
  /** Compile-time architecture ('x64'). */
  arch: string
  napiVersion: number
}

export type HubFetchJobBridge =
  | {
      status: 'ready'
      addonPath: string
      runtimeInfo: HubFetchJobRuntimeInfo
    }
  | {
      status: 'unavailable'
      code: HubFetchJobUnavailableCode
      detail: string
      addonPath: string | null
    }

/** Typed clone-support gate consumed by the Git containment layer. */
export type CloneSupport = {
  enabled: boolean
  reason: string | null
}

export interface HubFetchJobLoaderOptions {
  /** Explicit addon path (tests / QA). Takes precedence over every mode. */
  overridePath?: string
  isPackaged?: boolean
  /** app.getAppPath() — the dev root (apps/desktop) or the asar. */
  appPath?: string
  /** process.resourcesPath — packaged extra-resource root. */
  resourcesPath?: string
  platform?: NodeJS.Platform
  arch?: string
  modulesVersion?: string
  /** Injectable module loader for tests (avoids requiring a real .node). */
  loadModule?: (addonPath: string) => unknown
  checkExists?: (path: string) => boolean
}

export interface ResolvedAddonPath {
  path: string
  mode: 'override' | 'dev' | 'packaged'
}

/**
 * Deterministic dev/packaged path resolution. Override (tests/QA) wins,
 * then packaged (resources/native/<filename>), then dev
 * (native/windows/build/Release/<filename> under the app root).
 */
export function resolveHubFetchJobPath(
  opts: HubFetchJobLoaderOptions = {}
): ResolvedAddonPath | null {
  const { overridePath, isPackaged = false, appPath = '', resourcesPath = '' } = opts
  if (overridePath && overridePath.length > 0) {
    return { path: overridePath, mode: 'override' }
  }
  if (isPackaged && resourcesPath.length > 0) {
    return { path: join(resourcesPath, 'native', HUBFETCH_JOB_ADDON_FILENAME), mode: 'packaged' }
  }
  if (appPath.length > 0) {
    return {
      path: join(appPath, 'native', 'windows', 'build', 'Release', HUBFETCH_JOB_ADDON_FILENAME),
      mode: 'dev'
    }
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Validate the addon's export shape + runtime probe. Never throws. */
export function classifyRuntimeInfo(
  mod: unknown,
  modulesVersion: string
):
  | { ok: true; runtimeInfo: HubFetchJobRuntimeInfo }
  | { ok: false; code: HubFetchJobUnavailableCode; detail: string } {
  if (!isRecord(mod))
    return { ok: false, code: 'bad-exports', detail: 'module did not export an object' }
  if (mod.addonName !== HUBFETCH_JOB_ADDON_NAME) {
    return {
      ok: false,
      code: 'bad-exports',
      detail: `addonName=${JSON.stringify(mod.addonName)}, expected ${HUBFETCH_JOB_ADDON_NAME}`
    }
  }
  if (typeof mod.getRuntimeInfo !== 'function') {
    return {
      ok: false,
      code: 'bad-exports',
      detail: 'getRuntimeInfo export is missing or not a function'
    }
  }
  if (typeof mod.createKillOnCloseJob !== 'function') {
    return {
      ok: false,
      code: 'bad-exports',
      detail: 'createKillOnCloseJob export is missing or not a function'
    }
  }

  let info: unknown
  try {
    info = mod.getRuntimeInfo()
  } catch (err) {
    return {
      ok: false,
      code: 'bad-exports',
      detail: `getRuntimeInfo threw: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  if (!isRecord(info))
    return { ok: false, code: 'bad-exports', detail: 'getRuntimeInfo returned a non-object' }

  const nodeAbi = Number(info.nodeAbi)
  const arch = typeof info.arch === 'string' ? info.arch : ''
  const napiVersion = Number(info.napiVersion)
  if (!Number.isFinite(nodeAbi) || !Number.isFinite(napiVersion) || arch.length === 0) {
    return {
      ok: false,
      code: 'bad-exports',
      detail: `runtimeInfo is malformed: ${JSON.stringify(info)}`
    }
  }
  if (arch !== 'x64') {
    return { ok: false, code: 'wrong-arch', detail: `addon arch=${arch}, expected x64` }
  }
  if (nodeAbi !== Number(modulesVersion)) {
    return {
      ok: false,
      code: 'wrong-abi',
      detail: `addon NODE_MODULE_VERSION=${nodeAbi}, runtime process.versions.modules=${modulesVersion}`
    }
  }

  const runtimeInfo: HubFetchJobRuntimeInfo = {
    addonName: String(info.addonName),
    addonVersion: typeof info.addonVersion === 'string' ? info.addonVersion : '',
    nodeAbi,
    arch,
    napiVersion
  }
  return { ok: true, runtimeInfo }
}

function electronDefaults(): { isPackaged: boolean; appPath: string } {
  // In the real Electron main process `app` is the full API; under
  // ELECTRON_RUN_AS_NODE / plain Node the 'electron' module resolves to a path
  // string and app is undefined. Never throw on either.
  try {
    return {
      isPackaged: app?.isPackaged ?? false,
      appPath: typeof app?.getAppPath === 'function' ? app.getAppPath() : ''
    }
  } catch {
    return { isPackaged: false, appPath: '' }
  }
}

function defaultLoadModule(addonPath: string): unknown {
  // createRequire needs a base URL/path. import.meta.url exists under electron-vite
  // (ESM) and vitest; a CJS bundle (QA probe) has no import.meta, so fall back to a
  // cwd-based require. The addon path is always absolute, so the base is irrelevant
  // to resolution.
  const base =
    typeof import.meta.url === 'string'
      ? import.meta.url
      : join(process.cwd(), 'hubfetch-job-loader.cjs')
  return createRequire(base)(addonPath)
}

/**
 * Load and validate the bridge. The addon may be absent (dev before a native
 * build, or a stripped package) — that is a TYPED unavailable state, never a
 * throw. ABI/arch mismatches are classified without letting the module run.
 */
export function loadHubFetchJob(opts: HubFetchJobLoaderOptions = {}): HubFetchJobBridge {
  const platform = opts.platform ?? process.platform
  const arch = opts.arch ?? process.arch
  const modulesVersion = opts.modulesVersion ?? process.versions.modules
  const loadModule = opts.loadModule ?? defaultLoadModule
  const checkExists = opts.checkExists ?? existsSync

  if (platform !== 'win32' || arch !== 'x64') {
    return {
      status: 'unavailable',
      code: 'unsupported-platform',
      detail: `hubfetch_job requires Windows x64; platform=${platform}, arch=${arch}`,
      addonPath: null
    }
  }

  const defaults = electronDefaults()
  const resolved = resolveHubFetchJobPath({
    ...opts,
    isPackaged: opts.isPackaged ?? defaults.isPackaged,
    appPath: opts.appPath ?? defaults.appPath,
    resourcesPath: opts.resourcesPath ?? process.resourcesPath
  })
  if (!resolved) {
    return {
      status: 'unavailable',
      code: 'missing',
      detail: 'could not resolve an addon path for the current mode',
      addonPath: null
    }
  }

  if (!checkExists(resolved.path)) {
    return {
      status: 'unavailable',
      code: 'missing',
      detail: `addon not found at ${resolved.path}`,
      addonPath: resolved.path
    }
  }

  let mod: unknown
  try {
    mod = loadModule(resolved.path)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Node's loader refuses a module built for another ABI; classify it so the
    // failure is typed instead of a raw crash.
    if (/NODE_MODULE_VERSION|was compiled against a different Node\.js version/i.test(message)) {
      return {
        status: 'unavailable',
        code: 'wrong-abi',
        detail: message,
        addonPath: resolved.path
      }
    }
    return { status: 'unavailable', code: 'load-failed', detail: message, addonPath: resolved.path }
  }

  const classified = classifyRuntimeInfo(mod, modulesVersion)
  if (!classified.ok) {
    return {
      status: 'unavailable',
      code: classified.code,
      detail: classified.detail,
      addonPath: resolved.path
    }
  }
  return { status: 'ready', addonPath: resolved.path, runtimeInfo: classified.runtimeInfo }
}

/**
 * Typed clone-support gate. Todo 27 consumes this before arming a utility
 * worker; while it reports disabled, the clone entry must stay disabled and no
 * Git process may be spawned by the clone layer.
 */
export function getCloneSupport(bridge: HubFetchJobBridge): CloneSupport {
  if (bridge.status !== 'ready') {
    return { enabled: false, reason: `hubfetch_job unavailable: ${bridge.code}` }
  }
  return { enabled: true, reason: null }
}
