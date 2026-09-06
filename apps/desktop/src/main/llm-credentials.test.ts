import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { secretRegistry } from './security/secret-registry'
import { redactor } from './security/log'
import { Redactor } from './security/redaction'
import { SupportBundleBuilder } from './support-bundle'
import { DEFAULT_SETTINGS } from '@hubfetch/shared'
import type { LlmProvider } from '@hubfetch/shared'

function xorBytes(value: string | Buffer): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value)
  const out = Buffer.alloc(bytes.length)
  for (let i = 0; i < bytes.length; i++) out[i] = (bytes[i] ?? 0) ^ 0x5a
  return out
}

const electronMock = vi.hoisted(() => ({
  encryptionAvailable: true,
  appUserData: '',
}))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? (electronMock.appUserData as string) : ''),
    setPath: vi.fn(),
    setName: vi.fn(),
    setAppUserModelId: vi.fn(),
  },
  safeStorage: {
    isEncryptionAvailable: () => (electronMock.encryptionAvailable as boolean),
    encryptString: (value: string) => xorBytes(value),
    decryptString: (cipher: Buffer) => xorBytes(cipher).toString('utf8'),
  },
  net: { isOnline: () => true },
}))

import { llmCredentialsFile } from './runtime-paths'
import { LlmCredentialStore } from './llm-credentials'

const PROVIDERS: LlmProvider[] = ['openai', 'anthropic', 'gemini']
const SENTINELS: Record<LlmProvider, string> = {
  openai: 'sk-openai-sentinel-1111111111111111',
  anthropic: 'sk-ant-anthropic-sentinel-2222222222222222',
  gemini: 'AIza-gemini-sentinel-3333333333333333',
}

describe('LlmCredentialStore - Todo 3 (a-g)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hubfetch-llm-cred-test-'))
    process.env.HUBFETCH_CREDENTIALS_DIR = dir
    electronMock.encryptionAvailable = true
    secretRegistry.purge()
  })

  afterEach(() => {
    secretRegistry.purge()
    delete process.env.HUBFETCH_CREDENTIALS_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  it('(a) three keys round-trip independently', async () => {
    const store = new LlmCredentialStore()
    await store.load()
    expect(store.getStatus()).toEqual({ openai: false, anthropic: false, gemini: false })

    store.setKey('openai', SENTINELS.openai)
    store.setKey('anthropic', SENTINELS.anthropic)
    store.setKey('gemini', SENTINELS.gemini)

    expect(store.getStatus()).toEqual({ openai: true, anthropic: true, gemini: true })
    expect(store.getKey('openai')).toBe(SENTINELS.openai)
    expect(store.getKey('anthropic')).toBe(SENTINELS.anthropic)
    expect(store.getKey('gemini')).toBe(SENTINELS.gemini)

    // New instance loads same keys
    const store2 = new LlmCredentialStore()
    await store2.load()
    expect(store2.getStatus()).toEqual({ openai: true, anthropic: true, gemini: true })
    expect(store2.getKey('openai')).toBe(SENTINELS.openai)
    expect(store2.getKey('anthropic')).toBe(SENTINELS.anthropic)
    expect(store2.getKey('gemini')).toBe(SENTINELS.gemini)
    store2.dispose()
    store.dispose()
  })

  it('(b) plaintext never appears in file', () => {
    const store = new LlmCredentialStore()
    store.setKey('openai', SENTINELS.openai)
    store.setKey('anthropic', SENTINELS.anthropic)
    store.setKey('gemini', SENTINELS.gemini)

    const file = llmCredentialsFile()
    expect(existsSync(file)).toBe(true)
    const raw = readFileSync(file, 'utf8')
    for (const v of Object.values(SENTINELS)) {
      expect(raw.includes(v)).toBe(false)
    }
    // Must be versioned payload with cipher only
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['cipher', 'version'])
    expect(parsed.version).toBe(1)
    store.dispose()
  })

  it('(c) replacing/deleting one key leaves other two intact', async () => {
    const store = new LlmCredentialStore()
    store.setKey('openai', SENTINELS.openai)
    store.setKey('anthropic', SENTINELS.anthropic)
    store.setKey('gemini', SENTINELS.gemini)

    // Replace anthropic
    const replacement = 'sk-ant-replaced-9999999999999999'
    store.setKey('anthropic', replacement)
    expect(store.getKey('openai')).toBe(SENTINELS.openai)
    expect(store.getKey('anthropic')).toBe(replacement)
    expect(store.getKey('gemini')).toBe(SENTINELS.gemini)

    // Delete gemini
    store.deleteKey('gemini')
    expect(store.getKey('openai')).toBe(SENTINELS.openai)
    expect(store.getKey('anthropic')).toBe(replacement)
    expect(store.getKey('gemini')).toBeUndefined()
    expect(store.getStatus()).toEqual({ openai: true, anthropic: true, gemini: false })

    // Reload from disk - still intact
    const store2 = new LlmCredentialStore()
    await store2.load()
    expect(store2.getKey('openai')).toBe(SENTINELS.openai)
    expect(store2.getKey('anthropic')).toBe(replacement)
    expect(store2.getKey('gemini')).toBeUndefined()
    store2.dispose()
    store.dispose()
  })

  it('(d) corrupt ciphertext -> unconfigured, no plaintext, no deletion of HF creds', async () => {
    // Prepare HF credentials file sentinel
    const hfFile = join(dir, 'credentials.json')
    writeFileSync(hfFile, JSON.stringify({ version: 1, cipher: 'hf-sentinel-cipher' }))
    // Prepare corrupt llm file
    const llmFile = llmCredentialsFile()
    mkdirSync(dir, { recursive: true })
    writeFileSync(llmFile, JSON.stringify({ version: 1, cipher: 'not-base64-!!!corrupt' }))

    const store = new LlmCredentialStore()
    await store.load()
    expect(store.getStatus()).toEqual({ openai: false, anthropic: false, gemini: false })
    expect(store.getKey('openai')).toBeUndefined()

    // HF creds untouched
    expect(existsSync(hfFile)).toBe(true)
    expect(readFileSync(hfFile, 'utf8')).toContain('hf-sentinel-cipher')

    // Also test unsupported version fails closed
    writeFileSync(llmFile, JSON.stringify({ version: 999, cipher: Buffer.from('x').toString('base64') }))
    const store2 = new LlmCredentialStore()
    await store2.load()
    expect(store2.getStatus()).toEqual({ openai: false, anthropic: false, gemini: false })
    store.dispose()
    store2.dispose()
  })

  it('(e) loaded/transient keys redact from errors/logs', async () => {
    const store = new LlmCredentialStore()
    store.setKey('openai', SENTINELS.openai)
    // After setKey, key must be registered
    expect(secretRegistry.isRegistered(SENTINELS.openai)).toBe(true)
    // redactor must redact it
    const redacted = redactor.redactText(`error with key ${SENTINELS.openai} leaked`)
    expect(redacted.includes(SENTINELS.openai)).toBe(false)
    expect(redacted.includes('[REDACTED]')).toBe(true)

    // redactError path
    const err = new Error(`failed auth ${SENTINELS.openai}`)
    const redactedErr = redactor.redactError(err)
    expect(redactedErr.includes(SENTINELS.openai)).toBe(false)

    // transient key registration
    const transient = 'sk-transient-4444444444444444'
    const handle = store.registerTransient(transient)
    expect(secretRegistry.isRegistered(transient)).toBe(true)
    const redacted2 = redactor.redactText(`transient ${transient}`)
    expect(redacted2.includes(transient)).toBe(false)
    // unregister transient
    store.unregisterTransient(handle)
    expect(secretRegistry.isRegistered(transient)).toBe(false)

    // replacing key unregisters old
    const oldOpenAi = SENTINELS.openai
    const newOpenAi = 'sk-openai-new-5555555555555555'
    store.setKey('openai', newOpenAi)
    expect(secretRegistry.isRegistered(oldOpenAi)).toBe(false)
    expect(secretRegistry.isRegistered(newOpenAi)).toBe(true)
    // deleting unregisters
    store.deleteKey('openai')
    expect(secretRegistry.isRegistered(newOpenAi)).toBe(false)

    store.dispose()
  })

  it('(f) support bundle fails closed on synthetic registered key', async () => {
    const synthetic = 'sk-synthetic-6666666666666666'
    const store = new LlmCredentialStore()
    store.setKey('openai', synthetic)
    // The key is registered, so leakGuard will see it
    expect(secretRegistry.isRegistered(synthetic)).toBe(true)

    const builder = new SupportBundleBuilder({
      redactor: new Redactor(null),
      leakGuard: () => secretRegistry.liveSecrets(),
      clock: () => new Date('2026-08-15T12:00:00.000Z'),
    })
    const sources = {
      app: { app: 'HubFetch', version: '0.3.0' },
      system: { os: { platform: 'win32' } },
      diagnostics: { checks: [], completedAt: '2026-08-15T12:00:00.000Z' },
      settings: { ...DEFAULT_SETTINGS },
      tasks: [],
      mainLog: `leaked ${synthetic} in log`,
      rendererLog: '',
    } as unknown as Parameters<typeof builder.build>[1]

    await expect(builder.build(join(dir, 'bundle.zip'), sources)).rejects.toMatchObject({ code: 'leak' })
    expect(existsSync(join(dir, 'bundle.zip'))).toBe(false)
    store.dispose()
  })

  it('(g) HF sign-out does not alter llm-credentials.json', async () => {
    // Setup llm file
    const store = new LlmCredentialStore()
    store.setKey('openai', SENTINELS.openai)
    store.setKey('gemini', SENTINELS.gemini)
    const llmFile = llmCredentialsFile()
    const before = readFileSync(llmFile, 'utf8')

    // Simulate HF sign-out by exercising AuthManager.signOut on same dir
    // It should only touch credentials.json, not llm-credentials.json
    const { AuthManager } = await import('./auth')
    const { openDatabase } = await import('./db')
    // Use a mock DB that does nothing
    const db = { prepare: () => ({ run: () => undefined, get: () => undefined }) } as unknown as import('./db').AppDatabase
    const client = {
      whoAmI: vi.fn().mockResolvedValue({ name: 'tester', orgs: [] }),
      whoAmIWithToken: vi.fn(),
      whoAmIWithCookie: vi.fn(),
      invalidateCache: vi.fn(),
    }
    // Write HF creds so signOut has something to delete
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ version: 1, cipher: Buffer.from(JSON.stringify({ accessToken: 'hf_x', mode: 'token' })).toString('base64') }))
    const auth = new AuthManager(db, () => undefined)
    auth.attachClient(client as unknown as import('@hubfetch/hub-api').HubClient)
    await auth.signOut()

    // llm file unchanged
    expect(readFileSync(llmFile, 'utf8')).toBe(before)
    expect(existsSync(llmFile)).toBe(true)
    store.dispose()
  })

  it('encryption unavailable fails closed without plaintext', async () => {
    electronMock.encryptionAvailable = false
    const store = new LlmCredentialStore()
    // setKey should not write plaintext file
    store.setKey('openai', SENTINELS.openai)
    const file = llmCredentialsFile()
    // Should not have created a file with plaintext
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8')
      expect(raw.includes(SENTINELS.openai)).toBe(false)
    }
    // status remains unconfigured when encryption unavailable and file unreadable
    const store2 = new LlmCredentialStore()
    await store2.load()
    expect(store2.getStatus()).toEqual({ openai: false, anthropic: false, gemini: false })
    store.dispose()
    store2.dispose()
  })
})
