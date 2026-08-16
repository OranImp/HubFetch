import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserProfile } from '@hubfetch/shared'
import { HubApiError, type HubClient } from '@hubfetch/hub-api'
import { AuthManager } from './auth'
import { writeCredentialsFileAtomic } from './credential-file'
import { openDatabase } from './db'
import {
  APP_NAME,
  APP_USER_MODEL_ID,
  applyUserDataOverride,
  credentialsFile,
  databaseFile,
  DB_FILENAME,
  userDataDir
} from './runtime-paths'

function xorBytes(value: string | Buffer): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value)
  const out = Buffer.alloc(bytes.length)
  for (let i = 0; i < bytes.length; i++) out[i] = (bytes[i] ?? 0) ^ 0x5a
  return out
}

const electronMock = vi.hoisted(() => {
  const state = {
    userData: '',
    setPathCalls: [] as Array<[string, string]>,
    getPathCalls: [] as string[],
    setNameCalls: [] as string[]
  }
  return {
    state,
    safeStorage: {
      isEncryptionAvailable: () => true,
      // Reversible transform that guarantees no plaintext byte substring ever
      // survives into the stored payload — the vitest twin of real safeStorage.
      encryptString: (value: string) => xorBytes(value),
      decryptString: (cipher: Buffer) => xorBytes(cipher).toString('utf8')
    },
    net: { isOnline: () => true }
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      electronMock.state.getPathCalls.push(name)
      return name === 'userData' ? electronMock.state.userData : ''
    },
    setPath: (name: string, value: string) => {
      electronMock.state.setPathCalls.push([name, value])
      if (name === 'userData') electronMock.state.userData = value
    },
    setName: (name: string) => electronMock.state.setNameCalls.push(name),
    setAppUserModelId: vi.fn()
  },
  safeStorage: electronMock.safeStorage,
  net: electronMock.net
}))

// better-sqlite3 is built for Electron's ABI; vitest runs on system Node, so
// record the opened path without loading the native module.
const dbMock = vi.hoisted(() => {
  class MockDatabase {
    static opened: string[] = []
    readonly file: string

    constructor(file: string) {
      this.file = file
      MockDatabase.opened.push(file)
    }

    pragma(): unknown {
      return 0
    }

    exec(): void {}

    prepare(): { run: () => void; get: () => unknown } {
      return { run: () => undefined, get: () => undefined }
    }

    transaction<T>(fn: () => T): () => T {
      return fn
    }
  }
  return { MockDatabase }
})

vi.mock('better-sqlite3', () => ({ default: dbMock.MockDatabase }))

const USER = { name: 'tester', orgs: [] } as UserProfile
const roots: string[] = []

function newRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Encodes a token the way persistToken would with the mocked safeStorage. */
function cipherOf(token: object): string {
  return xorBytes(JSON.stringify(token)).toString('base64')
}

function writeCredentials(dir: string, token: object): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'credentials.json'),
    JSON.stringify({ version: 1, cipher: cipherOf(token) })
  )
}

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

const stubDb = () => ({ prepare: () => ({ run: () => undefined, get: () => undefined }) })

function makeAuth(
  client: ReturnType<typeof makeClient>,
  db: { prepare: () => { run: () => void; get: () => unknown } }
): AuthManager {
  const auth = new AuthManager(db as never, () => undefined)
  auth.attachClient(client as unknown as HubClient)
  return auth
}

describe('runtime identity constants', () => {
  it('uses HubFetch names end to end', () => {
    expect(APP_NAME).toBe('HubFetch')
    expect(APP_USER_MODEL_ID).toBe('io.github.oranimp.hubfetch')
    expect(DB_FILENAME).toBe('hubfetch.db')
  })
})

describe('applyUserDataOverride', () => {
  afterEach(() => {
    delete process.env.HUBFETCH_USER_DATA_DIR
    delete process.env.OMH_USER_DATA_DIR
  })

  it('honors HUBFETCH_USER_DATA_DIR before userData is read anywhere', () => {
    const override = newRoot('hubfetch-new-root-')
    process.env.HUBFETCH_USER_DATA_DIR = override
    applyUserDataOverride()
    expect(electronMock.state.setPathCalls).toContainEqual(['userData', override])
    expect(userDataDir()).toBe(override)
    expect(databaseFile()).toBe(join(override, 'hubfetch.db'))
  })

  it('never honors the legacy OMH_USER_DATA_DIR alias', () => {
    const oldDir = newRoot('hubfetch-old-env-root-')
    const newDir = newRoot('hubfetch-new-env-root-')
    process.env.OMH_USER_DATA_DIR = oldDir
    process.env.HUBFETCH_USER_DATA_DIR = newDir
    applyUserDataOverride()
    expect(electronMock.state.setPathCalls).not.toContainEqual(['userData', oldDir])
    expect(userDataDir()).toBe(newDir)
  })
})

describe('database path', () => {
  beforeEach(() => {
    dbMock.MockDatabase.opened = []
    delete process.env.HUBFETCH_USER_DATA_DIR
  })

  it('opens exactly hubfetch.db under the userData root', () => {
    const dataRoot = newRoot('hubfetch-db-root-')
    process.env.HUBFETCH_USER_DATA_DIR = dataRoot
    applyUserDataOverride()
    openDatabase()
    expect(dbMock.MockDatabase.opened).toEqual([join(dataRoot, 'hubfetch.db')])
  })

  it('never opens or touches an upstream oh-my-huggingface.db', () => {
    const dataRoot = newRoot('hubfetch-db-root-')
    const upstreamRoot = newRoot('hubfetch-upstream-root-')
    const upstreamDb = join(upstreamRoot, 'oh-my-huggingface.db')
    writeFileSync(upstreamDb, 'UPSTREAM-DB-SENTINEL')
    const upstreamHash = sha256(upstreamDb)

    process.env.HUBFETCH_USER_DATA_DIR = dataRoot
    applyUserDataOverride()
    openDatabase()

    expect(dbMock.MockDatabase.opened).toEqual([join(dataRoot, 'hubfetch.db')])
    expect(sha256(upstreamDb)).toBe(upstreamHash)
  })
})

describe('credentials path and old roots', () => {
  let client: ReturnType<typeof makeClient>

  beforeEach(() => {
    electronMock.state.userData = ''
    electronMock.state.setPathCalls = []
    delete process.env.HUBFETCH_USER_DATA_DIR
    delete process.env.HUBFETCH_CREDENTIALS_DIR
    delete process.env.OMH_USER_DATA_DIR
    delete process.env.OMH_CREDENTIALS_DIR
    client = makeClient()
  })

  it('leaves old ~/.oh_my_hf and upstream AppData roots unread and untouched', async () => {
    // Seed a legacy home-root credentials file exactly where the old app read.
    const oldHome = newRoot('hubfetch-old-home-')
    writeCredentials(join(oldHome, '.oh_my_hf'), { accessToken: 'hf_LEGACY_OLD', mode: 'token' })
    const oldCred = join(oldHome, '.oh_my_hf', 'credentials.json')
    const oldCredHash = sha256(oldCred)

    // Seed an upstream AppData-style profile with its own DB and credentials.
    const upstreamRoot = newRoot('hubfetch-upstream-appdata-')
    const upstreamDb = join(upstreamRoot, 'oh-my-huggingface.db')
    const upstreamCred = join(upstreamRoot, 'credentials.json')
    writeFileSync(upstreamDb, 'UPSTREAM-DB-SENTINEL')
    writeFileSync(upstreamCred, '{"version":1,"cipher":"UPSTREAM-CRED"}')
    const upstreamDbHash = sha256(upstreamDb)
    const upstreamCredHash = sha256(upstreamCred)

    // Fresh HubFetch roots.
    const newCredRoot = newRoot('hubfetch-new-cred-')
    const newDataRoot = newRoot('hubfetch-new-data-')
    process.env.HUBFETCH_CREDENTIALS_DIR = newCredRoot
    process.env.HUBFETCH_USER_DATA_DIR = newDataRoot
    applyUserDataOverride()

    client.whoAmI.mockRejectedValue(new HubApiError('unreachable', 500))
    const auth = makeAuth(client, stubDb())
    await auth.init()

    // The legacy token was never adopted (that would flip accessToken to it).
    expect(auth.getState().status).toBe('signedOut')
    expect(auth.accessToken()).toBeUndefined()

    // Old files are byte-for-byte untouched.
    expect(sha256(oldCred)).toBe(oldCredHash)
    expect(sha256(upstreamDb)).toBe(upstreamDbHash)
    expect(sha256(upstreamCred)).toBe(upstreamCredHash)

    // Only new roots were created; no .oh_my_hf resurrection anywhere.
    expect(existsSync(join(newDataRoot, '.oh_my_hf'))).toBe(false)
    expect(existsSync(join(newCredRoot, 'credentials.json'))).toBe(false)
  })

  it('round-trips credentials through safeStorage at the new path', async () => {
    const newCredRoot = newRoot('hubfetch-roundtrip-cred-')
    process.env.HUBFETCH_CREDENTIALS_DIR = newCredRoot

    client.whoAmIWithToken.mockResolvedValue({ user: USER })
    client.whoAmI.mockResolvedValue(USER)
    const first = makeAuth(client, stubDb())
    const result = await first.signInWithToken('hf_roundtrip')
    expect(result.ok).toBe(true)
    expect(existsSync(join(newCredRoot, 'credentials.json'))).toBe(true)

    // A fresh session restores the same token from the new path.
    const second = makeAuth(makeClient(), stubDb())
    second.attachClient(client as unknown as HubClient)
    await second.init()
    expect(second.getState().status).toBe('signedIn')
    expect(second.accessToken()).toBe('hf_roundtrip')
  })

  it('writes no plaintext secret bytes to credentials.json', async () => {
    const sentinel = 'hf_SENTINEL_7f3a9c2d_plaintext_marker'
    const newCredRoot = newRoot('hubfetch-sentinel-cred-')
    process.env.HUBFETCH_CREDENTIALS_DIR = newCredRoot

    client.whoAmIWithToken.mockResolvedValue({ user: USER })
    const auth = makeAuth(client, stubDb())
    const result = await auth.signInWithToken(sentinel)
    expect(result.ok).toBe(true)

    const file = join(newCredRoot, 'credentials.json')
    const raw = readFileSync(file, 'utf8')
    expect(raw.includes(sentinel)).toBe(false)
    expect(raw.includes('"accessToken"')).toBe(false)
    expect(Object.keys(JSON.parse(raw) as Record<string, unknown>).sort()).toEqual([
      'cipher',
      'version'
    ])
  })

  it('lets old env names have no effect on the credentials path', () => {
    const oldDir = newRoot('hubfetch-old-cred-env-')
    const newCredRoot = newRoot('hubfetch-new-cred-env-')
    electronMock.state.userData = newRoot('hubfetch-userdata-default-')

    process.env.OMH_CREDENTIALS_DIR = oldDir
    expect(credentialsFile()).toBe(join(electronMock.state.userData, 'credentials.json'))

    process.env.HUBFETCH_CREDENTIALS_DIR = newCredRoot
    expect(credentialsFile()).toBe(join(newCredRoot, 'credentials.json'))
  })
})

describe('atomic credentials write', () => {
  afterEach(() => {
    delete process.env.HUBFETCH_CREDENTIALS_DIR
  })

  it('leaves the previous valid file untouched when killed between temp write and rename', () => {
    const dir = newRoot('hubfetch-kill-dir-')
    const file = join(dir, 'credentials.json')
    const previous = '{"version":1,"cipher":"PREVIOUS-VALID"}'
    writeFileSync(file, previous)

    const killedDeps = {
      writeFile: (f: string, d: string, o: { mode: number }) => writeFileSync(f, d, o),
      rename: () => {
        throw new Error('killed mid-write')
      },
      restrictDacl: () => undefined,
      pid: 424242
    }
    expect(() =>
      writeCredentialsFileAtomic(file, '{"version":1,"cipher":"NEW"}', killedDeps)
    ).toThrow('killed mid-write')
    // Destination is byte-for-byte the previous valid file — never partial.
    expect(readFileSync(file, 'utf8')).toBe(previous)

    // A subsequent normal write completes atomically.
    writeCredentialsFileAtomic(file, '{"version":1,"cipher":"NEW"}')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, cipher: 'NEW' })
  })

  it('ignores a stale partial temp file left by a killed process', async () => {
    const dir = newRoot('hubfetch-stale-tmp-dir-')
    process.env.HUBFETCH_CREDENTIALS_DIR = dir
    const file = join(dir, 'credentials.json')
    writeFileSync(
      file,
      JSON.stringify({ version: 1, cipher: cipherOf({ accessToken: 'hf_stale', mode: 'token' }) })
    )
    writeFileSync(`${file}.99999.tmp`, '{"version":1,"cipher":"partial-garbage!!')

    const client = makeClient()
    client.whoAmI.mockResolvedValue(USER)
    const auth = makeAuth(client, stubDb())
    await auth.init()
    expect(auth.getState().status).toBe('signedIn')
    expect(auth.accessToken()).toBe('hf_stale')
    // The stale tmp never became the destination.
    expect(readFileSync(file, 'utf8')).not.toContain('partial-garbage')
  })

  it.skipIf(process.platform !== 'win32')(
    'grants a DACL restricted to the current user on Windows',
    () => {
      const dir = newRoot('hubfetch-dacl-dir-')
      const file = join(dir, 'credentials.json')
      writeCredentialsFileAtomic(file, '{"version":1,"cipher":"DACL-PROBE"}')

      const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe')
      const out = execFileSync(icacls, [file], { encoding: 'utf8' })
      const accounts = Array.from(out.matchAll(/\s+([^:]+):\([^)]*\)/g), (m) => m[1] ?? '').filter(
        (account) => account.length > 0
      )
      expect(accounts.length).toBeGreaterThan(0)
      for (const account of accounts) {
        expect(account).not.toMatch(/Everyone|BUILTIN|NT AUTHORITY|Authenticated Users|SYSTEM/i)
      }
      expect(
        accounts.some((a) => a.endsWith(`\\${userInfo().username}`) || a === userInfo().username)
      ).toBe(true)
    }
  )
})

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true })
    expect(existsSync(root)).toBe(false)
  }
})
