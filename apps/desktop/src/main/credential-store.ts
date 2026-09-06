import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import { z } from 'zod'
import type { UserProfile } from '@hubfetch/shared'
import { normalizeHubEndpoint } from '@hubfetch/shared'
import { writeCredentialsFileAtomic, restrictDaclToCurrentUser } from './credential-file'
import { credentialsFile } from './runtime-paths'

const MAX_ACCOUNTS = 16
const CORRUPT_BACKUP_RE = /^credentials\.corrupt\.(\d{8}T\d{6}Z)(?:-(\d+))?\.json$/

const orgSchema = z
  .object({
    name: z.string().min(1).max(128),
    fullname: z.string().max(256).optional(),
    avatarUrl: z.string().max(2048).optional(),
    plan: z.enum(['team', 'enterprise', 'plus', 'academia']).optional()
  })
  .strict()

const userSchema = z
  .object({
    name: z.string().min(1).max(128),
    fullname: z.string().max(256).optional(),
    email: z.string().max(320).optional(),
    avatarUrl: z.string().max(2048).optional(),
    isPro: z.boolean().optional(),
    orgs: z.array(orgSchema).max(100)
  })
  .strict()

const endpointSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      normalizeHubEndpoint(value)
      return true
    } catch {
      return false
    }
  }, 'invalid endpoint')
  .transform((value) => normalizeHubEndpoint(value))

const accountSchema = z
  .object({
    id: z.uuid(),
    endpoint: endpointSchema,
    user: userSchema,
    tokenDisplayName: z.string().max(256).optional(),
    tokenRole: z.string().max(128).optional(),
    invalid: z.literal(true).optional(),
    accessToken: z.string().min(1).max(512),
    sessionCookie: z.string().min(1).max(65_536).optional(),
    sessionUsername: z.string().min(1).max(128).optional(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true })
  })
  .strict()
  .superRefine((account, context) => {
    if (
      account.sessionUsername &&
      account.sessionUsername.toLowerCase() !== account.user.name.toLowerCase()
    ) {
      context.addIssue({ code: 'custom', path: ['sessionUsername'], message: 'session mismatch' })
    }
  })

const payloadSchema = z
  .object({
    activeAccountId: z.union([z.uuid(), z.null()]),
    accounts: z.array(accountSchema).max(MAX_ACCOUNTS)
  })
  .strict()
  .superRefine((payload, context) => {
    const ids = new Set<string>()
    for (const account of payload.accounts) {
      if (ids.has(account.id)) {
        context.addIssue({ code: 'custom', path: ['accounts'], message: 'duplicate account id' })
      }
      ids.add(account.id)
    }
    if (payload.activeAccountId !== null && !ids.has(payload.activeAccountId)) {
      context.addIssue({
        code: 'custom',
        path: ['activeAccountId'],
        message: 'unknown active account'
      })
    }
  })

const envelopeShape = z
  .object({ version: z.number().int(), cipher: z.string().min(1).max(4_000_000) })
  .strict()
const currentEnvelopeSchema = envelopeShape.extend({ version: z.literal(2) })
const legacyPayloadSchema = z
  .object({
    accessToken: z.string().min(1).max(512),
    mode: z.literal('token'),
    tokenDisplayName: z.string().max(256).optional(),
    tokenRole: z.string().max(128).optional(),
    sessionCookie: z.string().min(1).max(65_536).optional(),
    sessionUsername: z.string().min(1).max(128).optional()
  })
  .strict()

export type AccountCredential = z.infer<typeof accountSchema>
export type CredentialPayload = z.infer<typeof payloadSchema>
export type LegacyCredential = z.infer<typeof legacyPayloadSchema>

export type CredentialReadResult =
  | { readonly kind: 'empty' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'v1'; readonly token: LegacyCredential }
  | { readonly kind: 'loaded'; readonly payload: CredentialPayload }
  | { readonly kind: 'corrupt'; readonly backupFile: string }

export type CredentialMigrationResult =
  | { readonly kind: 'saved'; readonly payload: CredentialPayload }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'corrupt'; readonly backupFile: string }

export interface CredentialStoreOptions {
  readonly now?: () => Date
  readonly createId?: () => string
}

export class CredentialStore {
  private readonly now: () => Date
  private readonly createId: () => string

  constructor(
    private readonly file: string = credentialsFile(),
    options: CredentialStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? randomUUID
  }

  read(): CredentialReadResult {
    if (!safeStorage.isEncryptionAvailable()) return { kind: 'unavailable' }
    if (!existsSync(this.file)) return { kind: 'empty' }
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch {
      return this.quarantine()
    }
    let outer: unknown
    try {
      outer = JSON.parse(raw)
    } catch {
      return this.quarantine()
    }
    const shape = envelopeShape.safeParse(outer)
    if (!shape.success || (shape.data.version !== 1 && shape.data.version !== 2)) {
      return this.quarantine()
    }
    const decrypted = this.decrypt(shape.data.cipher)
    if (!decrypted) return this.quarantine()
    if (shape.data.version === 1) {
      const legacy = legacyPayloadSchema.safeParse(decrypted)
      return legacy.success ? { kind: 'v1', token: legacy.data } : this.quarantine()
    }
    const current = currentEnvelopeSchema.safeParse(outer)
    if (!current.success) return this.quarantine()
    const payload = payloadSchema.safeParse(decrypted)
    return payload.success ? { kind: 'loaded', payload: payload.data } : this.quarantine()
  }

  loadCredentials(): CredentialReadResult {
    return this.read()
  }

  save(payload: CredentialPayload): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false
    const parsed = payloadSchema.safeParse(payload)
    if (!parsed.success) return false
    try {
      const cipher = safeStorage.encryptString(JSON.stringify(parsed.data)).toString('base64')
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      writeCredentialsFileAtomic(this.file, JSON.stringify({ version: 2, cipher }))
      return true
    } catch {
      return false
    }
  }

  saveCredentials(payload: CredentialPayload): boolean {
    return this.save(payload)
  }

  migrateIfNeeded(
    loaded: CredentialReadResult,
    endpoint: string,
    user: UserProfile
  ): CredentialMigrationResult | null {
    switch (loaded.kind) {
      case 'v1':
        return this.migrateV1(loaded.token, endpoint, user)
      case 'corrupt':
        return loaded
      case 'empty':
      case 'unavailable':
      case 'loaded':
        return null
    }
  }

  listAccounts(payload?: CredentialPayload): AccountCredential[] {
    const loaded = payload === undefined ? this.read() : { kind: 'loaded' as const, payload }
    return loaded.kind === 'loaded' ? [...loaded.payload.accounts] : []
  }

  getActiveAccount(payload?: CredentialPayload): AccountCredential | null {
    const source = payload === undefined ? this.read() : { kind: 'loaded' as const, payload }
    if (source.kind !== 'loaded' || source.payload.activeAccountId === null) return null
    return (
      source.payload.accounts.find((account) => account.id === source.payload.activeAccountId) ?? null
    )
  }

  getAccountCredential(accountId: string, payload?: CredentialPayload): AccountCredential | null {
    const source = payload === undefined ? this.read() : { kind: 'loaded' as const, payload }
    if (source.kind !== 'loaded') return null
    return source.payload.accounts.find((account) => account.id === accountId) ?? null
  }

  switchAccount(accountId: string, payload?: CredentialPayload): CredentialPayload | null {
    const source = payload === undefined ? this.read() : { kind: 'loaded' as const, payload }
    if (source.kind !== 'loaded' || !this.getAccountCredential(accountId, source.payload)) return null
    return { ...source.payload, activeAccountId: accountId }
  }

  removeAccount(accountId: string, payload?: CredentialPayload): CredentialPayload | null {
    const source = payload === undefined ? this.read() : { kind: 'loaded' as const, payload }
    if (source.kind !== 'loaded') return null
    if (!source.payload.accounts.some((account) => account.id === accountId)) return null
    return {
      activeAccountId: source.payload.activeAccountId === accountId ? null : source.payload.activeAccountId,
      accounts: source.payload.accounts.filter((account) => account.id !== accountId)
    }
  }

  migrateV1(
    token: LegacyCredential,
    endpoint: string,
    user: UserProfile
  ): CredentialMigrationResult {
    const timestamp = this.now().toISOString()
    const account = accountSchema.safeParse({
      id: this.createId(),
      endpoint,
      user,
      accessToken: token.accessToken,
      ...(token.tokenDisplayName === undefined ? {} : { tokenDisplayName: token.tokenDisplayName }),
      ...(token.tokenRole === undefined ? {} : { tokenRole: token.tokenRole }),
      ...(token.sessionCookie === undefined ? {} : { sessionCookie: token.sessionCookie }),
      ...(token.sessionUsername === undefined ? {} : { sessionUsername: token.sessionUsername }),
      createdAt: timestamp,
      updatedAt: timestamp
    })
    if (!account.success) return this.quarantine()
    const migrated: CredentialPayload = {
      activeAccountId: account.data.id,
      accounts: [account.data]
    }
    if (!this.save(migrated)) {
      return { kind: 'unavailable' }
    }
    return { kind: 'saved', payload: migrated }
  }

  readLegacyCipher(cipher: Buffer): LegacyCredential | null {
    if (!safeStorage.isEncryptionAvailable()) return null
    try {
      const decrypted = JSON.parse(safeStorage.decryptString(cipher)) as unknown
      const parsed = legacyPayloadSchema.safeParse(decrypted)
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  clear(): void {
    rmSync(this.file, { force: true })
  }

  private decrypt(cipher: string): unknown | null {
    try {
      return JSON.parse(safeStorage.decryptString(Buffer.from(cipher, 'base64'))) as unknown
    } catch {
      return null
    }
  }

  private quarantine(): { readonly kind: 'corrupt'; readonly backupFile: string } {
    const stamp = this.now()
    const utc = `${stamp.getUTCFullYear().toString().padStart(4, '0')}${(stamp.getUTCMonth() + 1)
      .toString()
      .padStart(2, '0')}${stamp.getUTCDate().toString().padStart(2, '0')}T${stamp
      .getUTCHours()
      .toString()
      .padStart(2, '0')}${stamp.getUTCMinutes().toString().padStart(2, '0')}${stamp
      .getUTCSeconds()
      .toString()
      .padStart(2, '0')}Z`
    const directory = dirname(this.file)
    const base = `credentials.corrupt.${utc}`
    let target = join(directory, `${base}.json`)
    let suffix = 1
    while (existsSync(target)) target = join(directory, `${base}-${suffix++}.json`)
    try {
      renameSync(this.file, target)
      try {
        restrictDaclToCurrentUser(target)
      } catch {
        // Keep the untouched backup even when the platform ACL helper is unavailable.
      }
      this.retainNewestBackups(directory)
    } catch {
      return { kind: 'corrupt', backupFile: basename(target) }
    }
    return { kind: 'corrupt', backupFile: basename(target) }
  }

  private retainNewestBackups(directory: string): void {
    let backups: string[]
    try {
      backups = readdirSync(directory).filter((name) => CORRUPT_BACKUP_RE.test(name))
    } catch {
      return
    }
    backups.sort((left, right) => {
      const leftMatch = CORRUPT_BACKUP_RE.exec(left)
      const rightMatch = CORRUPT_BACKUP_RE.exec(right)
      const leftKey = leftMatch
        ? `${leftMatch[1]}${Number(leftMatch[2] ?? 0)
            .toString()
            .padStart(10, '0')}`
        : ''
      const rightKey = rightMatch
        ? `${rightMatch[1]}${Number(rightMatch[2] ?? 0)
            .toString()
            .padStart(10, '0')}`
        : ''
      return rightKey.localeCompare(leftKey)
    })
    for (const backup of backups.slice(5)) rmSync(join(directory, backup), { force: true })
  }
}
