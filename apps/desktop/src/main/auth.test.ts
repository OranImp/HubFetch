import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthState, UserProfile } from '@hubfetch/shared'
import { HubApiError, type HubClient } from '@hubfetch/hub-api'
import { AuthManager, type AuthManagerOptions } from './auth'
import type { AppDatabase } from './db'
import { secretRegistry } from './security/secret-registry'
import { MIGRATIONS } from './db'

const electronMock = vi.hoisted(() => ({
  encryptionAvailable: true,
  encryptThrows: false,
  online: true
}))

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  safeStorage: {
    isEncryptionAvailable: () => electronMock.encryptionAvailable,
    encryptString: (value: string) => {
      if (electronMock.encryptThrows) throw new Error('keychain unavailable')
      return Buffer.from(value, 'utf8')
    },
    decryptString: (cipher: Buffer) => cipher.toString('utf8')
  },
  net: { isOnline: () => electronMock.online }
}))

const USER = { name: 'tester', orgs: [] } as UserProfile

function makeClient(): {
  whoAmI: ReturnType<typeof vi.fn>
  whoAmIWithToken: ReturnType<typeof vi.fn>
  whoAmIWithCookie: ReturnType<typeof vi.fn>
  invalidateCache: ReturnType<typeof vi.fn>
} {
  return {
    whoAmI: vi.fn(),
    whoAmIWithToken: vi.fn(),
    whoAmIWithCookie: vi.fn(),
    invalidateCache: vi.fn()
  }
}

function makeDb(runImpl: () => void = () => {}): AppDatabase {
  return {
    prepare: () => ({ run: runImpl, get: () => undefined })
  } as unknown as AppDatabase
}

/** Matches the on-disk format persistToken writes with the mocked safeStorage. */
function writeCredentials(dir: string, token: object): void {
  writeFileSync(
    join(dir, 'credentials.json'),
    JSON.stringify({
      version: 1,
      cipher: Buffer.from(JSON.stringify(token), 'utf8').toString('base64')
    })
  )
}

function writeV2Credentials(dir: string, payload: object): void {
  writeFileSync(
    join(dir, 'credentials.json'),
    JSON.stringify({
      version: 2,
      cipher: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    })
  )
}

describe('AuthManager', () => {
  let dir: string
  let states: AuthState[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hubfetch-auth-test-'))
    process.env.HUBFETCH_CREDENTIALS_DIR = dir
    electronMock.encryptionAvailable = true
    electronMock.encryptThrows = false
    electronMock.online = true
    states = []
  })

  afterEach(() => {
    vi.useRealTimers()
    secretRegistry.purge()
    delete process.env.HUBFETCH_CREDENTIALS_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  function makeAuth(
    client: ReturnType<typeof makeClient>,
    db = makeDb(),
    options?: AuthManagerOptions
  ): AuthManager {
    const auth = new AuthManager(db, (state) => states.push(state), options)
    auth.attachClient(client as unknown as HubClient)
    return auth
  }

  it('keeps stored credentials on a startup 403 and retries', async () => {
    vi.useFakeTimers()
    writeCredentials(dir, { accessToken: 'hf_x', mode: 'token' })
    const client = makeClient()
    client.whoAmI.mockRejectedValue(new HubApiError('blocked', 403))
    const auth = makeAuth(client)
    await auth.init()
    expect(auth.getState().status).toBe('signedOut')
    // A 403 (WAF/geo block) must never destroy the credentials file.
    expect(existsSync(join(dir, 'credentials.json'))).toBe(true)
    // The retry loop restores the session once the block clears.
    client.whoAmI.mockResolvedValue(USER)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(auth.getState().status).toBe('signedIn')
  })

  it('signs out and wipes credentials only on a definitive startup 401', async () => {
    writeCredentials(dir, { accessToken: 'hf_x', mode: 'token' })
    const client = makeClient()
    client.whoAmI.mockRejectedValue(new HubApiError('revoked', 401))
    const auth = makeAuth(client)
    await auth.init()
    expect(auth.getState().status).toBe('signedOut')
    expect(existsSync(join(dir, 'credentials.json'))).toBe(false)
  })

  it('signInWithToken still signs in when persisting the token fails', async () => {
    electronMock.encryptThrows = true
    const client = makeClient()
    client.whoAmIWithToken.mockResolvedValue({ user: USER })
    const auth = makeAuth(client)
    const result = await auth.signInWithToken('hf_new')
    expect(result.ok).toBe(true)
    expect(auth.getState().status).toBe('signedIn')
    expect(states.at(-1)?.status).toBe('signedIn')
  })

  it('signOut completes even when clearing persisted state fails', async () => {
    const client = makeClient()
    client.whoAmIWithToken.mockResolvedValue({ user: USER })
    const auth = makeAuth(
      client,
      makeDb(() => {
        throw new Error('disk full')
      })
    )
    await auth.signInWithToken('hf_x')
    expect(auth.getState().status).toBe('signedIn')
    const state = await auth.signOut()
    expect(state).toMatchObject({ status: 'signedOut' })
    expect(auth.accessToken()).toBeUndefined()
  })

  it('signOut removes only the active account and never selects a fallback', async () => {
    const client = makeClient() as ReturnType<typeof makeClient> & { baseUrl: string }
    client.baseUrl = 'https://huggingface.co'
    client.whoAmIWithToken.mockResolvedValue({ user: USER })
    const auth = makeAuth(client)
    await auth.signInWithToken('hf_a')
    await auth.signInWithToken('hf_b')
    const active = auth.listAccounts().find((account) => account.active)
    if (!active) throw new Error('test account setup failed')

    const state = await auth.signOut()
    expect(state).toEqual({ status: 'signedOut' })
    expect(auth.listAccounts()).toHaveLength(1)
    expect(auth.listAccounts()[0]?.active).toBe(false)
    expect(auth.accessToken()).toBeUndefined()
    expect(await auth.signOut()).toEqual({ status: 'signedOut' })
    expect(auth.listAccounts()).toHaveLength(1)
  })

  it('detects a token revoked mid-session and signs out', async () => {
    vi.useFakeTimers()
    const client = makeClient()
    client.whoAmIWithToken.mockResolvedValue({ user: USER })
    client.whoAmI.mockRejectedValue(new HubApiError('revoked', 401))
    const auth = makeAuth(client)
    await auth.signInWithToken('hf_x')
    expect(auth.getState().status).toBe('signedIn')
    // Re-validation runs at 15 min plus up to 1 min of jitter.
    await vi.advanceTimersByTimeAsync(16 * 60_000)
    expect(auth.getState().status).toBe('signedOut')
    expect(existsSync(join(dir, 'credentials.json'))).toBe(false)
  })

  it('keeps the session when mid-run re-validation fails transiently', async () => {
    vi.useFakeTimers()
    const client = makeClient()
    client.whoAmIWithToken.mockResolvedValue({ user: USER })
    client.whoAmI.mockRejectedValue(new HubApiError('unavailable', 500))
    const auth = makeAuth(client)
    await auth.signInWithToken('hf_x')
    await vi.advanceTimersByTimeAsync(16 * 60_000)
    expect(auth.getState().status).toBe('signedIn')
    expect(existsSync(join(dir, 'credentials.json'))).toBe(true)
  })

  it('re-checks immediately when connectivity returns', async () => {
    vi.useFakeTimers()
    electronMock.online = false
    writeCredentials(dir, { accessToken: 'hf_x', mode: 'token' })
    const client = makeClient()
    client.whoAmI.mockRejectedValue(new TypeError('fetch failed'))
    const auth = makeAuth(client)
    await auth.init()
    expect(auth.getState().status).toBe('signedOut')
    client.whoAmI.mockResolvedValue(USER)
    electronMock.online = true
    // The online poll (5s cadence) fires the re-check without waiting out the backoff.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(auth.getState().status).toBe('signedIn')
  })

  it('loads every profile secret and releases them on file deletion and shutdown', async () => {
    const tokenA = 'hf_account_a_1234567890'
    const tokenB = 'hf_account_b_1234567890'
    const cookieA = 'token=cookie-a-1234567890; csrf=csrf-a-1234567890'
    const cookieB = 'token=cookie-b-1234567890; csrf=csrf-b-1234567890'
    writeV2Credentials(dir, {
      activeAccountId: '11111111-1111-4111-8111-111111111111',
      accounts: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          endpoint: 'https://huggingface.co',
          user: USER,
          accessToken: tokenA,
          sessionCookie: cookieA,
          sessionUsername: USER.name,
          createdAt: '2026-09-05T00:00:00.000Z',
          updatedAt: '2026-09-05T00:00:00.000Z'
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          endpoint: 'https://huggingface.co',
          user: USER,
          accessToken: tokenB,
          sessionCookie: cookieB,
          sessionUsername: USER.name,
          createdAt: '2026-09-05T00:00:00.000Z',
          updatedAt: '2026-09-05T00:00:00.000Z'
        }
      ]
    })
    const client = makeClient()
    client.whoAmI.mockResolvedValue(USER)
    const auth = makeAuth(client)
    await auth.init()

    expect(secretRegistry.isRegistered(tokenA)).toBe(true)
    expect(secretRegistry.isRegistered(tokenB)).toBe(true)
    expect(secretRegistry.isRegistered(cookieA)).toBe(true)
    expect(secretRegistry.isRegistered(cookieB)).toBe(true)
    rmSync(join(dir, 'credentials.json'), { force: true })
    auth.checkCredentialsFile()
    expect(auth.getState().status).toBe('signedOut')
    expect(secretRegistry.isRegistered(tokenA)).toBe(false)
    expect(secretRegistry.isRegistered(tokenB)).toBe(false)
    expect(secretRegistry.isRegistered(cookieA)).toBe(false)
    expect(secretRegistry.isRegistered(cookieB)).toBe(false)
    auth.dispose()
  })

  it('migrates the legacy database row and deletes it after v2 is written', async () => {
    const token = 'hf_legacy_database_token_1234567890'
    let deleteCount = 0
    const legacyCipher = Buffer.from(JSON.stringify({ accessToken: token, mode: 'token' }))
    const db = {
      prepare: (sql: string) => ({
        get: () => (sql.startsWith('SELECT') ? { token_cipher: legacyCipher } : undefined),
        run: () => {
          if (sql.startsWith('DELETE')) deleteCount += 1
        }
      })
    } as unknown as AppDatabase
    const client = makeClient()
    client.whoAmI.mockResolvedValue(USER)
    const auth = makeAuth(client, db)
    await auth.init()

    expect(auth.getState().status).toBe('signedIn')
    expect(JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8'))).toMatchObject({
      version: 2
    })
    expect(deleteCount).toBeGreaterThan(0)
  })

  it('claims legacy-local follows and inbox rows for the first migrated account transactionally', async () => {
    const db = new DatabaseSync(':memory:')
    for (const migration of MIGRATIONS) db.exec(migration)
    db.exec(
      `INSERT INTO follows (id, account_id, legacy_origin, type, target, created_at) VALUES ('legacy-follow', NULL, 'legacy-local', 'user', 'alice', '2026-01-01')`
    )
    db.exec(
      `INSERT INTO inbox (id, account_id, legacy_origin, kind, title, body, route, created_at) VALUES ('legacy-inbox', NULL, 'legacy-local', 'paper', 'legacy', 'body', '/papers/legacy', '2026-01-01')`
    )
    writeCredentials(dir, { accessToken: 'hf_legacy_migration', mode: 'token' })
    const client = makeClient() as ReturnType<typeof makeClient> & { baseUrl: string }
    client.baseUrl = 'https://huggingface.co'
    client.whoAmI.mockResolvedValue(USER)
    const auth = makeAuth(client, db as never)

    await auth.init()

    const accountId = auth.getActiveAccountId()
    expect(accountId).toBeTruthy()
    expect(db.prepare('SELECT account_id, legacy_origin FROM follows').get()).toEqual({
      account_id: accountId,
      legacy_origin: 'v1-migrated'
    })
    expect(db.prepare('SELECT account_id, legacy_origin FROM inbox').get()).toEqual({
      account_id: accountId,
      legacy_origin: 'v1-migrated'
    })
    db.close()
  })

  it('exposes only the corrupt backup basename and leaves no replacement file', async () => {
    const original = JSON.stringify({ version: 3, cipher: 'unsupported' })
    writeFileSync(join(dir, 'credentials.json'), original)
    const auth = makeAuth(makeClient())
    await auth.init()

    const state = auth.getState()
    expect(state.status).toBe('credential-corrupt')
    if (state.status === 'credential-corrupt') {
      expect(state.backupFile).toMatch(/^credentials\.corrupt\./)
      expect(state.backupFile).not.toContain(dir)
    }
    expect(existsSync(join(dir, 'credentials.json'))).toBe(false)
  })

  it('adds two endpoint-bound accounts, deduplicates exact credentials, and lists safe summaries', async () => {
    const client = makeClient() as ReturnType<typeof makeClient> & { baseUrl: string }
    client.baseUrl = 'https://huggingface.co'
    client.whoAmIWithToken.mockImplementation(async (token: string) => ({
      user: { name: token === 'hf_a' ? 'account-a' : 'account-b', orgs: [] },
      tokenDisplayName: token === 'hf_a' ? 'A' : 'B',
      tokenRole: 'write'
    }))
    const auth = makeAuth(client)

    await auth.signInWithToken('hf_a')
    const first = auth.listAccounts()
    await auth.signInWithToken('hf_a')
    expect(auth.listAccounts()).toHaveLength(1)

    client.baseUrl = 'https://mirror.example'
    await auth.signInWithToken('hf_b')
    const accounts = auth.listAccounts()
    expect(accounts).toHaveLength(2)
    expect(accounts.map((account) => account.endpoint).sort()).toEqual([
      'https://huggingface.co',
      'https://mirror.example'
    ])
    expect(accounts.every((account) => !('accessToken' in account))).toBe(true)
    expect(accounts.every((account) => !('sessionCookie' in account))).toBe(true)
    expect(accounts.find((account) => account.endpoint === 'https://huggingface.co')?.active).toBe(
      false
    )
    expect(accounts.find((account) => account.endpoint === 'https://mirror.example')?.active).toBe(
      true
    )
    expect(first[0]?.id).toBe(
      accounts.find((account) => account.endpoint === 'https://huggingface.co')?.id
    )
  })

  it('switches only after validation and leaves the active account untouched on transient failures', async () => {
    const client = makeClient() as ReturnType<typeof makeClient> & { baseUrl: string }
    client.baseUrl = 'https://huggingface.co'
    client.whoAmIWithToken.mockImplementation(async (token: string) => ({
      user: { name: token, orgs: [] }
    }))
    const auth = makeAuth(client)
    await auth.signInWithToken('hf_a')
    await auth.signInWithToken('hf_b')
    const accountA = auth.listAccounts().find((account) => account.user.name === 'hf_a')
    const accountB = auth.listAccounts().find((account) => account.user.name === 'hf_b')
    if (!accountA || !accountB) throw new Error('test account setup failed')

    const switched = await auth.switchAccount(accountA.id)
    expect(switched).toMatchObject({ ok: true, state: { accountId: accountA.id } })
    client.whoAmIWithToken.mockRejectedValueOnce(new HubApiError('blocked', 403))
    const before = auth.getState()
    const cacheBefore = client.invalidateCache.mock.calls.length
    const failed = await auth.switchAccount(accountB.id)
    expect(failed).toEqual({ ok: false, error: 'forbidden' })
    expect(auth.getState()).toEqual(before)
    expect(client.invalidateCache).toHaveBeenCalledTimes(cacheBefore)
  })

  it('rejects endpoint-mismatched switches without network or cache activity', async () => {
    const client = makeClient() as ReturnType<typeof makeClient> & { baseUrl: string }
    client.baseUrl = 'https://huggingface.co'
    client.whoAmIWithToken.mockResolvedValue({ user: USER })
    const auth = makeAuth(client)
    await auth.signInWithToken('hf_a')
    client.baseUrl = 'https://mirror.example'
    await auth.signInWithToken('hf_b')
    const accountA = auth.listAccounts().find((account) => account.user.name === USER.name)
    if (!accountA) throw new Error('test account setup failed')
    const callsBefore = client.whoAmIWithToken.mock.calls.length
    const cacheBefore = client.invalidateCache.mock.calls.length
    const result = await auth.switchAccount(accountA.id)
    expect(result).toMatchObject({ ok: false, error: 'endpoint-mismatch', settings: 'network' })
    expect(client.whoAmIWithToken).toHaveBeenCalledTimes(callsBefore)
    expect(client.invalidateCache).toHaveBeenCalledTimes(cacheBefore)
    expect(auth.getState().status).toBe('signedIn')
  })

  it('marks a 401-selected profile invalid and refuses its credential lease', async () => {
    const client = makeClient() as ReturnType<typeof makeClient> & { baseUrl: string }
    client.baseUrl = 'https://huggingface.co'
    client.whoAmIWithToken.mockResolvedValue({ user: USER })
    const auth = makeAuth(client)
    await auth.signInWithToken('hf_a')
    await auth.signInWithToken('hf_b')
    const accountA = auth.listAccounts()[0]
    if (!accountA) throw new Error('test account setup failed')
    client.whoAmIWithToken.mockRejectedValueOnce(new HubApiError('revoked', 401))
    const result = await auth.switchAccount(accountA.id)
    expect(result).toEqual({ ok: false, error: 'invalid', accountId: accountA.id })
    expect(auth.getState()).toMatchObject({ status: 'signedIn', accountId: expect.any(String) })
    expect(auth.listAccounts().find((account) => account.id === accountA.id)?.invalid).toBe(true)
    expect(() => auth.leaseAccountCredential(accountA.id)).toThrow('account-invalid')
  })

  it('blocks removal with subsystem counts, then signs out only the active profile', async () => {
    const client = makeClient() as ReturnType<typeof makeClient> & { baseUrl: string }
    client.baseUrl = 'https://huggingface.co'
    client.whoAmIWithToken.mockResolvedValue({ user: USER })
    let busyAccountId = ''
    const auth = makeAuth(client, makeDb(), {
      accountUsage: (accountId) =>
        accountId === busyAccountId
          ? { downloads: 1, clones: 2, uploads: 3 }
          : { downloads: 0, clones: 0, uploads: 0 }
    })
    await auth.signInWithToken('hf_a')
    await auth.signInWithToken('hf_b')
    const active = auth.listAccounts().find((account) => account.active)
    const inactive = auth.listAccounts().find((account) => !account.active)
    if (!active || !inactive) throw new Error('test account setup failed')

    busyAccountId = inactive.id
    const blocked = auth.removeAccount(inactive.id)
    expect(blocked).toMatchObject({ ok: false, error: 'account-in-use' })
    expect(blocked).toMatchObject({ counts: { downloads: 1, clones: 2, uploads: 3, total: 6 } })
    busyAccountId = ''
    const removed = auth.removeAccount(active.id)
    expect(removed).toMatchObject({ ok: true, state: { status: 'signedOut' } })
    expect(auth.listAccounts()).toHaveLength(1)
    expect(auth.listAccounts()[0]?.active).toBe(false)
    expect(auth.accessToken()).toBeUndefined()
  })

  it('clears every account and lease when the credentials file is deleted externally', async () => {
    const client = makeClient() as ReturnType<typeof makeClient> & { baseUrl: string }
    client.baseUrl = 'https://huggingface.co'
    client.whoAmIWithToken.mockResolvedValue({ user: USER })
    const auth = makeAuth(client)
    await auth.signInWithToken('hf_a')
    await auth.signInWithToken('hf_b')
    expect(auth.listAccounts()).toHaveLength(2)
    const active = auth.listAccounts().find((account) => account.active)
    if (!active) throw new Error('test account setup failed')
    const lease = auth.leaseAccountCredential(active.id)
    expect(lease.accountId).toBe(active.id)
    expect(lease.accessToken).toBe('hf_b')
    lease.release()
    rmSync(join(dir, 'credentials.json'), { force: true })
    auth.checkCredentialsFile()
    expect(auth.listAccounts()).toEqual([])
    expect(auth.getState()).toEqual({ status: 'signedOut' })
    expect(() => auth.leaseAccountCredential('11111111-1111-4111-8111-111111111111')).toThrow(
      'account-not-found'
    )
  })

  it('reconciles an externally deleted credentials file after a dropped watcher event', async () => {
    vi.useFakeTimers()
    const client = makeClient() as ReturnType<typeof makeClient> & { baseUrl: string }
    client.baseUrl = 'https://huggingface.co'
    client.whoAmIWithToken.mockResolvedValue({ user: USER })
    const auth = makeAuth(client)
    await auth.signInWithToken('hf_a')
    rmSync(join(dir, 'credentials.json'), { force: true })

    await vi.advanceTimersByTimeAsync(30_000)

    expect(auth.getState()).toEqual({ status: 'signedOut' })
    expect(auth.listAccounts()).toEqual([])
  })

  it('does not treat its own atomic credential rewrite as external deletion', async () => {
    vi.useFakeTimers()
    const client = makeClient() as ReturnType<typeof makeClient> & { baseUrl: string }
    client.baseUrl = 'https://huggingface.co'
    client.whoAmIWithToken.mockResolvedValue({ user: USER })
    const auth = makeAuth(client)
    await auth.signInWithToken('hf_a')
    await auth.signInWithToken('hf_b')

    await vi.advanceTimersByTimeAsync(30_000)

    expect(auth.getState().status).toBe('signedIn')
    expect(auth.listAccounts()).toHaveLength(2)
  })
})
