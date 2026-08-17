// apps/desktop/src/main/askpass/askpass-broker.test.ts
//
// Todo 30: the AskPass broker is the main-process owner of one Job-bound
// AskPass session per app-token clone. These tests lock the EXACT contract:
//   - env additions are ONLY GIT_ASKPASS + HUBFETCH_ASKPASS_PIPE +
//     GIT_TERMINAL_PROMPT=0 + the GIT_CONFIG_COUNT/KEY_0/VALUE_0 credential
//     helper clearing; argv gets `-c credential.helper=`;
//   - the JS Buffer handed to native is zeroed immediately after the native
//     copy;
//   - the token is registered with the Todo 22 SecretRegistry for the session
//     lifetime and released on close;
//   - one active session at a time (never reused across tasks);
//   - empty / multiline tokens and a missing helper fail typed;
//   - helper path resolution: override > packaged > dev.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  AskPassBroker,
  AskPassError,
  HUBFETCH_ASKPASS_PIPE_VAR,
  resolveAskPassHelperPath,
  type AskPassNativeSession
} from './askpass-broker'
import type { HubFetchJobHandle } from '../native/hubfetch-job-loader'
import { secretRegistry } from '../security/secret-registry'

const JOB = {} as HubFetchJobHandle

function fakeSession(overrides: Partial<AskPassNativeSession> = {}): AskPassNativeSession {
  return {
    close: vi.fn(() => ({ ok: true })),
    stats: vi.fn(() => ({
      pipeName: 'HubFetchAskPass-qa',
      state: 0,
      connections: 0,
      promptsServed: 0,
      rejected: 0,
      lastRejectReason: 0,
      promptLimit: 4,
      ttlMs: 60000
    })),
    zeroizeProof: vi.fn(() => ({
      tokenCleared: true,
      usernameCleared: true,
      jobHandleReleased: true
    })),
    ...overrides
  }
}

function makeBroker(
  opts: {
    helperPath?: string | null
    onSession?: (options: { token: Buffer }) => { pipeName: string; session: AskPassNativeSession }
  } = {}
) {
  const sessions: Array<{ token: Buffer; options: unknown }> = []
  const broker = new AskPassBroker({
    resolveHelperPath: () =>
      opts.helperPath === undefined ? 'C:\\helper\\HubFetchAskPass.exe' : opts.helperPath,
    createSession: (options) => {
      sessions.push({ token: options.token, options })
      const captured = opts.onSession?.(options) ?? null
      return (
        captured ?? {
          pipeName: 'HubFetchAskPass-' + String(sessions.length),
          session: fakeSession()
        }
      )
    }
  })
  return { broker, sessions }
}

afterEach(() => {
  secretRegistry.purge()
})

describe('AskPassBroker.openSession', () => {
  it('sets ONLY the exact app-token env + argv contract', () => {
    const { broker } = makeBroker()
    const bundle = broker.openSession({ token: 'hf_token_abc123', job: JOB })
    expect(bundle.env).toEqual({
      GIT_ASKPASS: 'C:\\helper\\HubFetchAskPass.exe',
      [HUBFETCH_ASKPASS_PIPE_VAR]: bundle.pipeName,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: ''
    })
    // The EXACT credential.helper= clearing also lands in the Git child argv.
    expect(bundle.argv).toEqual(['-c', 'credential.helper='])
    // Only these variables — no SSH_ASKPASS, no GCM_*, no token anywhere.
    expect(Object.keys(bundle.env).sort()).toEqual([
      'GIT_ASKPASS',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_VALUE_0',
      'GIT_TERMINAL_PROMPT',
      HUBFETCH_ASKPASS_PIPE_VAR
    ])
    bundle.close()
  })

  it('zeroes the JS Buffer immediately after the native copy', () => {
    let seen: Buffer | null = null
    const { broker } = makeBroker({
      onSession: (options) => {
        seen = options.token
        return { pipeName: 'p', session: fakeSession() }
      }
    })
    const bundle = broker.openSession({ token: 'hf_token_abc123', job: JOB })
    expect(seen).not.toBeNull()
    // The buffer the native addon saw must be fully zeroed by the time
    // openSession returns (the native copy happened synchronously).
    expect(seen!.toString('utf8')).toBe('\0'.repeat('hf_token_abc123'.length))
    bundle.close()
  })

  it('registers the token with the Todo 22 SecretRegistry for the session lifetime', () => {
    const { broker } = makeBroker()
    expect(secretRegistry.isRegistered('hf_token_abc123')).toBe(false)
    const bundle = broker.openSession({ token: 'hf_token_abc123', job: JOB })
    expect(secretRegistry.isRegistered('hf_token_abc123')).toBe(true)
    bundle.close()
    expect(secretRegistry.isRegistered('hf_token_abc123')).toBe(false)
  })

  it('trims the token before registering and copying', () => {
    const { broker } = makeBroker()
    const bundle = broker.openSession({ token: '  hf_token_abc123\n', job: JOB })
    // The trimmed value is registered; the raw value with whitespace is not.
    expect(secretRegistry.isRegistered('hf_token_abc123')).toBe(true)
    bundle.close()
  })

  it('refuses a second concurrent session (never reused across tasks)', () => {
    const { broker } = makeBroker()
    const first = broker.openSession({ token: 'hf_token_abc123', job: JOB })
    expect(() => broker.openSession({ token: 'hf_token_other456', job: JOB })).toThrow(AskPassError)
    first.close()
    // After close, a new session is allowed (fresh pipe, fresh session).
    const second = broker.openSession({ token: 'hf_token_other456', job: JOB })
    expect(second.pipeName).not.toBe(first.pipeName)
    second.close()
  })

  it('rejects an empty token (not signed in) with a typed error', () => {
    const { broker } = makeBroker()
    expect(() => broker.openSession({ token: '', job: JOB })).toThrow(AskPassError)
    expect(() => broker.openSession({ token: '   ', job: JOB })).toThrow(AskPassError)
  })

  it('rejects a multiline token (single-line contract)', () => {
    const { broker } = makeBroker()
    expect(() => broker.openSession({ token: 'line1\nline2', job: JOB })).toThrow(AskPassError)
    expect(() => broker.openSession({ token: 'line1\rline2', job: JOB })).toThrow(AskPassError)
  })

  it('fails typed when the packaged helper is unavailable', () => {
    const { broker } = makeBroker({ helperPath: null })
    expect(() => broker.openSession({ token: 'hf_token_abc123', job: JOB })).toThrow(AskPassError)
  })

  it('uses hf_user as the username answer by default', () => {
    const { broker, sessions } = makeBroker()
    const bundle = broker.openSession({ token: 'hf_token_abc123', job: JOB })
    expect((sessions[0]?.options as { username?: string }).username).toBe('hf_user')
    bundle.close()
  })

  it('closeAll zeroizes the active session and is idempotent', () => {
    const close = vi.fn(() => ({ ok: true }))
    const { broker } = makeBroker({
      onSession: () => ({ pipeName: 'p', session: fakeSession({ close }) })
    })
    broker.openSession({ token: 'hf_token_abc123', job: JOB })
    expect(broker.isActive()).toBe(true)
    broker.closeAll()
    expect(close).toHaveBeenCalledTimes(1)
    expect(broker.isActive()).toBe(false)
    expect(secretRegistry.isRegistered('hf_token_abc123')).toBe(false)
    broker.closeAll()
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('resolveAskPassHelperPath', () => {
  it('resolves the dev path under the app root', () => {
    expect(resolveAskPassHelperPath({ appPath: 'C:\\dev\\apps\\desktop' })).toBe(
      join('C:\\dev\\apps\\desktop', 'native', 'windows', 'build', 'Release', 'HubFetchAskPass.exe')
    )
  })

  it('resolves the packaged path under resources/native', () => {
    expect(
      resolveAskPassHelperPath({ isPackaged: true, resourcesPath: 'C:\\pkg\\resources' })
    ).toBe(join('C:\\pkg\\resources', 'native', 'HubFetchAskPass.exe'))
  })

  it('gives the override precedence over every mode', () => {
    expect(
      resolveAskPassHelperPath({
        overridePath: 'D:\\qa\\HubFetchAskPass.exe',
        isPackaged: true,
        resourcesPath: 'C:\\pkg\\resources'
      })
    ).toBe('D:\\qa\\HubFetchAskPass.exe')
  })

  it('returns null when no mode can resolve a path', () => {
    expect(resolveAskPassHelperPath({ isPackaged: true })).toBeNull()
    expect(resolveAskPassHelperPath({})).toBeNull()
  })
})
