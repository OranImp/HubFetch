// apps/desktop/src/main/askpass/askpass-broker.ts
//
// Todo 30: one-shot Job-bound AskPass sessions for app-token clones.
//
// The broker is the main-process owner of an AskPass session:
//   - it resolves the packaged `HubFetchAskPass.exe` helper;
//   - it registers the app token with the Todo 22 SecretRegistry for the
//     session's lifetime and hands the native addon a ZEROIZABLE copy, then
//     zeroes the JS Buffer immediately after the native copy;
//   - it builds the EXACT app-token Git environment contract — only
//     `GIT_ASKPASS`, `HUBFETCH_ASKPASS_PIPE`, `GIT_TERMINAL_PROMPT=0`, and the
//     `credential.helper` clearing via `GIT_CONFIG_COUNT=1
//     GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=` — plus the
//     equivalent `-c credential.helper=` argv, applied to that clone's Git
//     child only;
//   - it enforces ONE active session at a time (a session is never reused
//     across tasks), closes/zeroizes the native session at clone terminal,
//     cancel, or app shutdown, and keeps the token out of every durable store.
//
// System GCM/SSH clones (auth 'system') never call this broker: they receive
// neither the app token nor the helper override.
import { join } from 'node:path'
import type { HubFetchJobHandle } from '../native/hubfetch-job-loader'
import { secretRegistry, type SecretHandle } from '../security/secret-registry'

export const HUBFETCH_ASKPASS_PIPE_VAR = 'HUBFETCH_ASKPASS_PIPE'
export const HUBFETCH_ASKPASS_HELPER_PATH_OVERRIDE = 'HUBFETCH_ASKPASS_HELPER_PATH'
export const ASKPASS_HELPER_FILENAME = 'HubFetchAskPass.exe'

/** The username Git sends for Hugging Face HTTPS Basic auth (token = password). */
export const HF_USERNAME = 'hf_user'

/** Typed failure for any AskPass misuse (never a raw throw from native). */
export class AskPassError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(`askpass: ${reason}`)
    this.name = 'AskPassError'
    this.reason = reason
  }
}

/** The addon surface the broker needs (a subset of the hubfetch_job bridge). */
export interface AskPassAddonSession {
  createAskPassSession(options: {
    token: Buffer
    username: string
    job: HubFetchJobHandle
    ttlMs: number
    promptLimit: number
    allowUsername: boolean
    allowPassword: boolean
  }): { pipeName: string; session: unknown }
}

export interface AskPassNativeSession {
  close(): { ok: boolean }
  stats(): AskPassSessionStats
  zeroizeProof(): { tokenCleared: boolean; usernameCleared: boolean; jobHandleReleased: boolean }
}

export interface AskPassSessionStats {
  pipeName: string
  state: number
  connections: number
  promptsServed: number
  rejected: number
  lastRejectReason: number
  promptLimit: number
  ttlMs: number
}

/** The bundle merged into one app-token clone's effective Git env/argv. */
export interface AskPassSessionBundle {
  pipeName: string
  env: Record<string, string>
  argv: string[]
  close(): void
  stats(): AskPassSessionStats
}

export interface AskPassBrokerOptions {
  /** The addon's createAskPassSession (from the ready hubfetch_job bridge). */
  createSession: AskPassAddonSession['createAskPassSession']
  /** Absolute path to the packaged helper exe (or null → app-token clones fail typed). */
  resolveHelperPath: () => string | null
}

export interface OpenSessionOptions {
  token: string
  /** Defaults to `hf_user`, the Hub's Basic-auth username. */
  username?: string
  job: HubFetchJobHandle
  ttlMs?: number
  promptLimit?: number
  allowUsername?: boolean
  allowPassword?: boolean
}

interface ActiveSession extends AskPassSessionBundle {
  secretHandle: SecretHandle
}

/**
 * Dev / packaged helper resolution. Override (tests/QA) wins, then packaged
 * (`resources/native/HubFetchAskPass.exe`), then dev
 * (`native/windows/build/Release/HubFetchAskPass.exe` under the app root).
 */
export function resolveAskPassHelperPath(options: {
  overridePath?: string
  isPackaged?: boolean
  appPath?: string
  resourcesPath?: string
}): string | null {
  const overridePath = options.overridePath ?? process.env[HUBFETCH_ASKPASS_HELPER_PATH_OVERRIDE]
  if (overridePath && overridePath.length > 0) return overridePath
  if (options.isPackaged && options.resourcesPath && options.resourcesPath.length > 0) {
    return join(options.resourcesPath, 'native', ASKPASS_HELPER_FILENAME)
  }
  if (options.appPath && options.appPath.length > 0) {
    return join(options.appPath, 'native', 'windows', 'build', 'Release', ASKPASS_HELPER_FILENAME)
  }
  return null
}

export class AskPassBroker {
  private active: ActiveSession | null = null

  constructor(private readonly options: AskPassBrokerOptions) {}

  /**
   * Open ONE Job-bound session for one app-token clone. Throws AskPassError on
   * any misuse (no token, multiline token, missing helper, concurrent session).
   * The returned bundle's env/argv are the exact contract for the clone's Git
   * child; `close()` zeroizes the native session and releases the SecretRegistry
   * registration. The JS Buffer passed to native is zeroed immediately after
   * the native copy.
   */
  openSession(options: OpenSessionOptions): AskPassSessionBundle {
    if (this.active !== null) {
      throw new AskPassError('an AskPass session is already active for this process')
    }
    const helperPath = this.options.resolveHelperPath()
    if (helperPath === null) {
      throw new AskPassError('HubFetchAskPass.exe is not available')
    }
    const token = options.token.trim()
    if (token.length === 0) {
      throw new AskPassError('app-token clones require a signed-in token')
    }
    if (token.includes('\r') || token.includes('\n')) {
      throw new AskPassError('the token must be a single line')
    }
    const username = options.username ?? HF_USERNAME
    const secretHandle = secretRegistry.register(token)
    const tokenBuffer = Buffer.from(token, 'utf8')
    try {
      const created = this.options.createSession({
        token: tokenBuffer,
        username,
        job: options.job,
        ttlMs: options.ttlMs ?? 60_000,
        promptLimit: options.promptLimit ?? 4,
        allowUsername: options.allowUsername ?? true,
        allowPassword: options.allowPassword ?? true
      })
      const env: Record<string, string> = {
        GIT_ASKPASS: helperPath,
        [HUBFETCH_ASKPASS_PIPE_VAR]: created.pipeName,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: ''
      }
      const argv = ['-c', 'credential.helper=']
      const session = created.session as AskPassNativeSession
      const active: ActiveSession = {
        pipeName: created.pipeName,
        env,
        argv,
        close: () => {
          try {
            session.close()
          } finally {
            secretRegistry.unregister(secretHandle)
            if (this.active === active) this.active = null
          }
        },
        stats: () => session.stats(),
        secretHandle
      }
      this.active = active
      return active
    } finally {
      // Zero the JS copy now that native holds its own zeroizable copy.
      tokenBuffer.fill(0)
    }
  }

  /** Close the active session (app shutdown / sign-out). Idempotent. */
  closeAll(): void {
    if (this.active !== null) {
      const active = this.active
      this.active = null
      try {
        active.close()
      } catch {
        secretRegistry.unregister(active.secretHandle)
      }
    }
  }

  /** Whether a session is currently open (never reuse across tasks). */
  isActive(): boolean {
    return this.active !== null
  }
}
