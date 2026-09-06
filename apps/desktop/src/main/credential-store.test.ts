import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserProfile } from '@hubfetch/shared'
import { CredentialStore, type AccountCredential, type CredentialPayload } from './credential-store'

const electronMock = vi.hoisted(() => ({
  encryptionAvailable: true,
  encryptThrows: false
}))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => electronMock.encryptionAvailable,
    encryptString: (value: string) => {
      if (electronMock.encryptThrows) throw new Error('keychain unavailable')
      return Buffer.from(value, 'utf8')
    },
    decryptString: (cipher: Buffer) => cipher.toString('utf8')
  }
}))

const USER: UserProfile = { name: 'tester', orgs: [] }
const TOKEN = 'hf_test_token_1234567890'
const COOKIE = 'token=session-cookie-1234567890; csrf=csrf-token-1234567890'

function legacyCipher(token: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(token), 'utf8').toString('base64')
}

function writeV1(file: string, token: Record<string, unknown>): string {
  const raw = JSON.stringify({ version: 1, cipher: legacyCipher(token) })
  writeFileSync(file, raw)
  return raw
}

function account(id: string, token: string): AccountCredential {
  return {
    id,
    endpoint: 'https://huggingface.co',
    user: USER,
    accessToken: token,
    tokenDisplayName: 'work token',
    tokenRole: 'write',
    sessionCookie: COOKIE,
    sessionUsername: USER.name,
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z'
  }
}

function payload(accounts: readonly AccountCredential[]): CredentialPayload {
  return { activeAccountId: accounts[0]?.id ?? null, accounts: [...accounts] }
}

describe('CredentialStore', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hubfetch-credential-store-'))
    file = join(dir, 'credentials.json')
    electronMock.encryptionAvailable = true
    electronMock.encryptThrows = false
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('migrates v1 to one stable v2 account without plaintext', () => {
    writeV1(file, {
      accessToken: TOKEN,
      mode: 'token',
      tokenDisplayName: 'work token',
      tokenRole: 'write',
      sessionCookie: COOKIE,
      sessionUsername: USER.name
    })
    const store = new CredentialStore(file)
    const loaded = store.read()
    expect(loaded.kind).toBe('v1')
    if (loaded.kind !== 'v1') return

    const migrated = store.migrateV1(loaded.token, 'https://huggingface.co/', USER)
    expect(migrated.kind).toBe('saved')
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain(TOKEN)
    expect(raw).not.toContain(COOKIE)
    expect(JSON.parse(raw)).toMatchObject({ version: 2 })

    const restarted = new CredentialStore(file).read()
    expect(restarted.kind).toBe('loaded')
    if (restarted.kind !== 'loaded') return
    expect(restarted.payload.accounts).toHaveLength(1)
    expect(restarted.payload.accounts[0]?.id).toBeDefined()
    expect(restarted.payload.accounts[0]?.endpoint).toBe('https://huggingface.co')
    expect(restarted.payload.accounts[0]?.accessToken).toBe(TOKEN)
    expect(restarted.payload.activeAccountId).toBe(restarted.payload.accounts[0]?.id)
    const secondRead = new CredentialStore(file).read()
    expect(secondRead.kind).toBe('loaded')
    if (secondRead.kind === 'loaded') {
      expect(secondRead.payload.accounts[0]?.id).toBe(restarted.payload.accounts[0]?.id)
    }
  })

  it('round-trips multiple profiles with the exact v2 payload shape', () => {
    const first = account('11111111-1111-4111-8111-111111111111', TOKEN)
    const second = account('22222222-2222-4222-8222-222222222222', 'hf_second_token_1234567890')
    const store = new CredentialStore(file)
    expect(store.save(payload([first, second]))).toBe(true)

    const loaded = store.read()
    expect(loaded.kind).toBe('loaded')
    if (loaded.kind !== 'loaded') return
    expect(loaded.payload).toEqual(payload([first, second]))
    expect(Object.keys(loaded.payload.accounts[0] ?? {}).sort()).toEqual([
      'accessToken',
      'createdAt',
      'endpoint',
      'id',
      'sessionCookie',
      'sessionUsername',
      'tokenDisplayName',
      'tokenRole',
      'updatedAt',
      'user'
    ])
  })

  it('quarantines malformed v1 bytes without creating a replacement file', () => {
    const original = writeV1(file, { accessToken: TOKEN, mode: 'token' })
    writeFileSync(file, `${original}truncated`)
    const store = new CredentialStore(file, { now: () => new Date('2026-09-05T01:02:03.000Z') })
    const loaded = store.read()

    expect(loaded.kind).toBe('corrupt')
    expect(existsSync(file)).toBe(false)
    const backup = loaded.kind === 'corrupt' ? loaded.backupFile : ''
    expect(backup).toMatch(/^credentials\.corrupt\.20260905T010203Z\.json$/)
    expect(readFileSync(join(dir, backup), 'utf8')).toBe(`${original}truncated`)
    expect(backup).not.toContain(TOKEN)
  })

  it('rejects duplicate ids and retains only the newest five backups', () => {
    const first = account('11111111-1111-4111-8111-111111111111', TOKEN)
    const duplicate = account('11111111-1111-4111-8111-111111111111', 'hf_other_token_1234567890')
    const store = new CredentialStore(file, { now: () => new Date('2026-09-05T01:02:03.000Z') })
    expect(store.save(payload([first, duplicate]))).toBe(false)
    expect(existsSync(file)).toBe(false)

    for (let index = 0; index < 6; index += 1) {
      const backup = join(dir, `credentials.corrupt.20260905T01020${index}Z.json`)
      writeFileSync(backup, `backup-${index}`)
    }
    writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        cipher: Buffer.from(JSON.stringify(payload([first, duplicate]))).toString('base64')
      })
    )
    const result = new CredentialStore(file, {
      now: () => new Date('2026-09-05T01:02:10.000Z')
    }).read()
    expect(result.kind).toBe('corrupt')
    const backups = readdirSync(dir).filter((name) => name.startsWith('credentials.corrupt.'))
    expect(backups).toHaveLength(5)
    expect(backups).toContain('credentials.corrupt.20260905T010210Z.json')
  })

  it('rejects a session username that does not match the cached profile', () => {
    const invalid = account('11111111-1111-4111-8111-111111111111', TOKEN)
    const mismatch = { ...invalid, sessionUsername: 'different-user' }
    const store = new CredentialStore(file)
    expect(store.save(payload([mismatch]))).toBe(false)
    expect(existsSync(file)).toBe(false)
  })

  it('keeps a valid file untouched when encryption is unavailable', () => {
    writeV1(file, { accessToken: TOKEN, mode: 'token' })
    electronMock.encryptionAvailable = false
    const original = readFileSync(file, 'utf8')
    const result = new CredentialStore(file).read()
    expect(result.kind).toBe('unavailable')
    expect(readFileSync(file, 'utf8')).toBe(original)
    expect(readdirSync(dir).filter((name) => name.startsWith('credentials.corrupt.'))).toEqual([])
  })

  it.skipIf(process.platform !== 'win32')('restricts corrupt backups to the current user', () => {
    writeFileSync(file, '{invalid-json')
    const result = new CredentialStore(file).read()
    expect(result.kind).toBe('corrupt')
    if (result.kind !== 'corrupt') return
    const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe')
    const output = execFileSync(icacls, [join(dir, result.backupFile)], { encoding: 'utf8' })
    const accounts = Array.from(output.matchAll(/\s+([^:]+):\([^)]*\)/g), (match) => match[1] ?? '')
    expect(accounts.some((account) => account.endsWith(`\\${userInfo().username}`))).toBe(true)
    expect(
      accounts.some((account) => /Everyone|BUILTIN|NT AUTHORITY|Authenticated Users/i.test(account))
    ).toBe(false)
  })
})
