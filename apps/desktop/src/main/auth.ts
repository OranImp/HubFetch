import { existsSync, mkdirSync, statSync, watch, type FSWatcher } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { net } from 'electron'
import type {
  AccountRemoveResult,
  AccountSummary,
  AccountSwitchResult,
  AccountUsageCounts,
  AuthState,
  HubSessionConnectResult,
  SignOutResult,
  TokenSignInResult,
  UserProfile
} from '@hubfetch/shared'
import { hubRelativeUrl, normalizeHubEndpoint } from '@hubfetch/shared'
import type { HubClient } from '@hubfetch/hub-api'
import { isForbidden, isUnauthorized } from '@hubfetch/hub-api'
import {
  CredentialStore,
  type AccountCredential,
  type CredentialPayload,
  type CredentialMigrationResult,
  type CredentialReadResult,
  type LegacyCredential
} from './credential-store'
import type { AppDatabase } from './db'
import { LEGACY_LOCAL_ORIGIN, MIGRATED_ACCOUNT_ORIGIN } from './db'
import { credentialsFile } from './runtime-paths'
import { logger } from './security/log'
import { secretRegistry, type SecretHandle } from './security/secret-registry'

/**
 * Credentials live under the HubFetch userData root — `<userData>\credentials.json`
 * — shared by dev and packaged sessions through the shared app name. Still
 * safeStorage-encrypted and never plaintext; the file itself is written
 * atomically with a DACL restricted to the current user. Tests isolate
 * themselves via HUBFETCH_CREDENTIALS_DIR. No legacy shared-credentials
 * location is ever read, written, or migrated.
 */

type StoredToken = LegacyCredential

export interface AccountCredentialLease {
  readonly accountId: string
  readonly accountLabel: string
  readonly accessToken: string
  readonly sessionCookie?: string
  readonly release: () => void
}

export type AccountUsage = Omit<AccountUsageCounts, 'total'>

export interface AuthManagerOptions {
  readonly accountUsage?: (accountId: string) => AccountUsage
  readonly credentialStore?: CredentialStore
}

export class AccountCredentialUnavailableError extends Error {
  override readonly name = 'AccountCredentialUnavailableError'

  constructor(
    readonly code: 'account-not-found' | 'account-invalid' | 'account-unavailable',
    readonly accountId: string
  ) {
    super(`${code}: ${accountId}`)
  }
}

/**
 * Retry backoff after a transient (network/5xx/403) whoAmI failure at startup:
 * starts low so a brief blip resolves fast, doubles up to the ceiling.
 */
const RETRY_FLOOR_MS = 5_000
const RETRY_CEIL_MS = 60_000
/** While offline, poll cheap net.isOnline() so reconnect triggers an immediate re-check. */
const ONLINE_POLL_MS = 5_000
/** Re-validate the session periodically so a token revoked mid-run is detected. */
const REVALIDATE_MS = 15 * 60_000
/** Random spread added per cycle so many clients don't re-validate in lockstep. */
const REVALIDATE_JITTER_MS = 60_000
/** Collapse bursts of fs.watch events into one credentials-file check. */
const WATCH_DEBOUNCE_MS = 500

export class AuthManager {
  private state: AuthState = { status: 'signedOut' }
  private accounts: AccountCredential[] = []
  private activeAccountId: string | null = null
  private pendingToken: StoredToken | null = null
  private readonly credentialStore: CredentialStore
  private retryTimer: NodeJS.Timeout | null = null
  private retryDelay = RETRY_FLOOR_MS
  private onlineTimer: NodeJS.Timeout | null = null
  private revalidateTimer: NodeJS.Timeout | null = null
  private revalidateInFlight = false
  private accountUsage: (accountId: string) => AccountUsage
  private credentialsWatcher: FSWatcher | null = null
  private watchDebounce: NodeJS.Timeout | null = null
  private credentialsReconciliationTimer: NodeJS.Timeout | null = null
  /** True while the store rewrites the shared file, so the watcher ignores our own churn. */
  private persisting = false
  /** Whether this session has loaded credentials from the shared file. */
  private credentialsFileLoaded = false
  /**
   * Bumped whenever the session owner changes intent (sign-out, new sign-in).
   * An in-flight whoAmI from a previous epoch must discard its result instead
   * of resurrecting a token the user just discarded.
   */
  private epoch = 0
  /** Handles keep every loaded account token/cookie registered, including inactive profiles. */
  private registeredSecretHandles: SecretHandle[] = []
  private readonly activeLeases = new Set<AccountCredentialLease>()
  private readonly credentialsUnavailableListeners = new Set<
    (accountIds: readonly string[]) => void
  >()
  private client!: HubClient

  constructor(
    private readonly db: AppDatabase,
    private readonly onChange: (state: AuthState) => void,
    options: AuthManagerOptions = {}
  ) {
    this.credentialStore = options.credentialStore ?? new CredentialStore()
    this.accountUsage = options.accountUsage ?? (() => ({ downloads: 0, clones: 0, uploads: 0 }))
  }

  attachClient(client: HubClient): void {
    this.client = client
  }

  setAccountUsage(accountUsage: (accountId: string) => AccountUsage): void {
    this.accountUsage = accountUsage
  }

  onEndpointChanged(): void {
    const active = this.activeAccount()
    if (!active || active.endpoint === this.currentEndpoint()) return
    this.epoch += 1
    this.clearRevalidate()
    this.client.invalidateCache()
    if (this.state.status === 'signedIn') this.setState({ status: 'signedOut' })
  }

  private currentEndpoint(): string {
    return normalizeHubEndpoint(this.client.baseUrl)
  }

  getState(): AuthState {
    return this.state
  }

  getActiveAccountId(): string | null {
    return this.activeAccountId
  }

  activeAccountLabel(): string | null {
    return this.activeAccount()?.user.name ?? null
  }

  listAccounts(): AccountSummary[] {
    this.checkCredentialsFile()
    return this.accounts.map((account) => this.accountSummary(account, this.activeAccountId))
  }

  getAccountCredential(accountId: string): AccountCredential {
    this.checkCredentialsFile()
    const account = this.accounts.find((entry) => entry.id === accountId)
    if (!account) throw new AccountCredentialUnavailableError('account-not-found', accountId)
    if (account.invalid) throw new AccountCredentialUnavailableError('account-invalid', accountId)
    return account
  }

  leaseAccountCredential(accountId: string): AccountCredentialLease {
    this.reconcileCredentialsFile()
    const account = this.getAccountCredential(accountId)
    let released = false
    const lease: AccountCredentialLease = {
      accountId,
      accountLabel: account.user.name,
      accessToken: account.accessToken,
      ...(account.sessionCookie ? { sessionCookie: account.sessionCookie } : {}),
      release: () => {
        if (released) return
        released = true
        this.activeLeases.delete(lease)
      }
    }
    this.activeLeases.add(lease)
    return lease
  }

  private accountSummary(
    account: AccountCredential,
    activeAccountId: string | null
  ): AccountSummary {
    return {
      id: account.id,
      endpoint: account.endpoint,
      user: account.user,
      ...(account.tokenDisplayName === undefined
        ? {}
        : { tokenDisplayName: account.tokenDisplayName }),
      ...(account.tokenRole === undefined ? {} : { tokenRole: account.tokenRole }),
      hubSession: Boolean(account.sessionCookie),
      active: account.id === activeAccountId,
      ...(account.invalid ? { invalid: true as const } : {})
    }
  }

  private accountUsageCounts(accountId: string): AccountUsageCounts {
    const usage = this.accountUsage(accountId)
    return {
      ...usage,
      total: usage.downloads + usage.clones + usage.uploads
    }
  }

  private activeAccount(): AccountCredential | null {
    if (this.activeAccountId === null) return null
    return this.accounts.find((account) => account.id === this.activeAccountId) ?? null
  }

  private refreshSecretRegistrations(): void {
    for (const handle of this.registeredSecretHandles) secretRegistry.unregister(handle)
    this.registeredSecretHandles = []
    const values = this.accounts.flatMap((account) =>
      account.sessionCookie ? [account.accessToken, account.sessionCookie] : [account.accessToken]
    )
    if (this.pendingToken) {
      values.push(this.pendingToken.accessToken)
      if (this.pendingToken.sessionCookie) values.push(this.pendingToken.sessionCookie)
    }
    for (const value of values) {
      try {
        this.registeredSecretHandles.push(secretRegistry.register(value))
      } catch {
        // A value shorter than the registry minimum is still protected by structural redaction.
      }
    }
  }

  private setAccounts(
    accounts: readonly AccountCredential[],
    activeAccountId: string | null
  ): void {
    this.accounts = [...accounts]
    this.activeAccountId = activeAccountId
    this.pendingToken = null
    this.refreshSecretRegistrations()
    this.ensureCredentialsReconciliation()
  }

  private setPendingToken(token: StoredToken | null): void {
    this.accounts = []
    this.activeAccountId = null
    this.pendingToken = token
    this.refreshSecretRegistrations()
    this.ensureCredentialsReconciliation()
  }

  private clearCredentialsMemory(): void {
    for (const lease of this.activeLeases) lease.release()
    this.setAccounts([], null)
    this.pendingToken = null
    this.refreshSecretRegistrations()
    this.stopCredentialsReconciliation()
  }

  onCredentialsUnavailable(listener: (accountIds: readonly string[]) => void): () => void {
    this.credentialsUnavailableListeners.add(listener)
    return () => this.credentialsUnavailableListeners.delete(listener)
  }

  private ensureCredentialsReconciliation(): void {
    if (this.credentialsReconciliationTimer || (!this.accounts.length && !this.pendingToken)) return
    this.credentialsReconciliationTimer = setInterval(() => this.reconcileCredentialsFile(), 30_000)
    this.credentialsReconciliationTimer.unref?.()
  }

  private stopCredentialsReconciliation(): void {
    if (this.credentialsReconciliationTimer) clearInterval(this.credentialsReconciliationTimer)
    this.credentialsReconciliationTimer = null
  }

  private reconcileCredentialsFile(): void {
    if (this.persisting || !this.credentialsFileLoaded) return
    try {
      statSync(credentialsFile())
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        this.checkCredentialsFile()
        return
      }
      logger.warn('auth', 'credentials reconciliation stat failed', error)
    }
  }

  private claimLegacyLibraryRows(accountId: string): void {
    try {
      const claim = (): void => {
        this.db
          .prepare(
            'UPDATE follows SET account_id = ?, legacy_origin = ? WHERE account_id IS NULL AND legacy_origin = ?'
          )
          .run(accountId, MIGRATED_ACCOUNT_ORIGIN, LEGACY_LOCAL_ORIGIN)
        this.db
          .prepare(
            'UPDATE inbox SET account_id = ?, legacy_origin = ? WHERE account_id IS NULL AND legacy_origin = ?'
          )
          .run(accountId, MIGRATED_ACCOUNT_ORIGIN, LEGACY_LOCAL_ORIGIN)
      }
      const transaction = (
        this.db as AppDatabase & {
          transaction?: (fn: () => void) => () => void
        }
      ).transaction
      if (transaction) transaction.call(this.db, claim)()
      else claim()
    } catch (error) {
      logger.warn('auth', 'failed to claim legacy library rows', error)
    }
  }

  /** Called by HubClient on every request. */
  accessToken(): string | undefined {
    const active = this.activeAccount()
    return active && !active.invalid && active.endpoint === this.currentEndpoint()
      ? active.accessToken
      : this.pendingToken?.accessToken
  }

  /** Called by HubClient on cookie-authenticated (social write) requests. */
  sessionCookie(): string | undefined {
    const active = this.activeAccount()
    return active && !active.invalid && active.endpoint === this.currentEndpoint()
      ? active.sessionCookie
      : this.pendingToken?.sessionCookie
  }

  private setState(state: AuthState): void {
    this.state = state
    // Only signed-in sessions re-validate; the timer dies with the session.
    if (state.status === 'signedIn') this.scheduleRevalidate()
    else this.clearRevalidate()
    this.onChange(state)
  }

  private signedInState(user: UserProfile): AuthState {
    const active = this.activeAccount()
    if (!active || active.invalid) return { status: 'signedOut' }
    return {
      status: 'signedIn',
      accountId: active.id,
      user,
      method: 'token',
      ...(active.tokenDisplayName === undefined
        ? {}
        : { tokenDisplayName: active.tokenDisplayName }),
      ...(active.tokenRole === undefined ? {} : { tokenRole: active.tokenRole }),
      hubSession: Boolean(active.sessionCookie)
    }
  }

  private persistPayload(payload: CredentialPayload): boolean {
    this.persisting = true
    try {
      const saved = this.credentialStore.saveCredentials(payload)
      if (!saved) {
        logger.warn(
          'auth',
          'OS encryption unavailable or credential write failed; memory-only session'
        )
        return false
      }
      this.credentialsFileLoaded = true
      this.db.prepare('DELETE FROM auth WHERE id = 1').run()
      return true
    } finally {
      this.persisting = false
    }
  }

  private clearPersistedCredentials(): void {
    this.persisting = true
    try {
      this.credentialStore.clear()
      this.credentialsFileLoaded = false
      this.db.prepare('DELETE FROM auth WHERE id = 1').run()
    } finally {
      this.persisting = false
    }
  }

  private loadPersistedCredentials(): CredentialReadResult {
    const loaded = this.credentialStore.loadCredentials()
    if (loaded.kind !== 'empty') return loaded
    const row = this.db.prepare('SELECT token_cipher FROM auth WHERE id = 1').get() as
      { token_cipher: Buffer } | undefined
    if (!row) return { kind: 'empty' }
    const token = this.credentialStore.readLegacyCipher(row.token_cipher)
    if (!token) {
      this.db.prepare('DELETE FROM auth WHERE id = 1').run()
      return { kind: 'empty' }
    }
    return { kind: 'v1', token }
  }

  /** Retry later WITHOUT touching stored credentials — transient failures only. */
  private scheduleRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      void this.init()
    }, this.retryDelay)
    this.retryTimer.unref?.()
    this.retryDelay = Math.min(this.retryDelay * 2, RETRY_CEIL_MS)
    this.watchOnline()
  }

  /** Cancel the startup retry loop (a definitive outcome was reached) and reset its backoff. */
  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    if (this.onlineTimer) clearInterval(this.onlineTimer)
    this.onlineTimer = null
    this.retryDelay = RETRY_FLOOR_MS
  }

  /**
   * Backoff alone leaves a restored session signed out for up to the ceiling
   * after connectivity returns; poll net.isOnline() while offline so the retry
   * fires the moment we are back online.
   */
  private watchOnline(): void {
    if (this.onlineTimer || net.isOnline()) return
    this.onlineTimer = setInterval(() => {
      if (!net.isOnline()) return
      if (this.onlineTimer) clearInterval(this.onlineTimer)
      this.onlineTimer = null
      if (this.retryTimer) clearTimeout(this.retryTimer)
      this.retryTimer = null
      void this.init()
    }, ONLINE_POLL_MS)
    this.onlineTimer.unref?.()
  }

  /** Restore the session at startup (also the retry entry point after transient failures). */
  async init(): Promise<void> {
    if (this.state.status !== 'signedOut') return
    this.ensureCredentialsWatch()
    const loaded = this.loadPersistedCredentials()
    if (loaded.kind === 'unavailable' || loaded.kind === 'empty') return
    if (loaded.kind === 'corrupt') {
      this.clearCredentialsMemory()
      this.credentialsFileLoaded = false
      this.setState({ status: 'credential-corrupt', backupFile: loaded.backupFile })
      return
    }
    this.credentialsFileLoaded = true
    if (loaded.kind === 'v1') this.setPendingToken(loaded.token)
    else this.setAccounts(loaded.payload.accounts, loaded.payload.activeAccountId)
    const active = this.activeAccount()
    if (active?.invalid || (active && active.endpoint !== this.currentEndpoint())) return
    if (!active && !this.pendingToken) return
    try {
      const user = await this.client.whoAmI()
      this.clearRetry()
      if (loaded.kind === 'v1' && this.pendingToken) {
        this.persisting = true
        let migrated: CredentialMigrationResult | null
        try {
          migrated = this.credentialStore.migrateIfNeeded(loaded, this.currentEndpoint(), user)
        } finally {
          this.persisting = false
        }
        if (migrated === null) return
        if (migrated.kind === 'corrupt') {
          this.clearCredentialsMemory()
          this.credentialsFileLoaded = false
          this.setState({ status: 'credential-corrupt', backupFile: migrated.backupFile })
          return
        }
        if (migrated.kind === 'saved') {
          this.setAccounts(migrated.payload.accounts, migrated.payload.activeAccountId)
          this.db.prepare('DELETE FROM auth WHERE id = 1').run()
          if (migrated.payload.activeAccountId !== null) {
            this.claimLegacyLibraryRows(migrated.payload.activeAccountId)
          }
        }
        if (migrated.kind === 'unavailable') {
          const pending = this.pendingToken
          if (!pending) return
          const timestamp = new Date().toISOString()
          const account: AccountCredential = {
            id: randomUUID(),
            endpoint: this.currentEndpoint(),
            user,
            accessToken: pending.accessToken,
            ...(pending.tokenDisplayName === undefined
              ? {}
              : { tokenDisplayName: pending.tokenDisplayName }),
            ...(pending.tokenRole === undefined ? {} : { tokenRole: pending.tokenRole }),
            ...(pending.sessionCookie === undefined
              ? {}
              : { sessionCookie: pending.sessionCookie }),
            ...(pending.sessionUsername === undefined
              ? {}
              : { sessionUsername: pending.sessionUsername }),
            createdAt: timestamp,
            updatedAt: timestamp
          }
          this.setAccounts([account], account.id)
        }
      }
      this.setState(this.signedInState(user))
    } catch (err) {
      if (isUnauthorized(err)) {
        // Definitive 401 only: the token was revoked. A 403 (WAF challenge,
        // geo block, proxy) is transient and must never wipe stored credentials.
        await this.signOut()
        return
      }
      logger.warn('auth', 'whoAmI failed at startup', err)
      this.scheduleRetry()
    }
  }

  /**
   * Deleting `<userData>\credentials.json` is the documented "sign out
   * everywhere" gesture; honor it for running sessions too. Watching the
   * directory (not the file) survives the atomic rename-based rewrites.
   */
  private ensureCredentialsWatch(): void {
    if (this.credentialsWatcher) return
    const file = credentialsFile()
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const watcher = watch(dirname(file), (_event, filename) => {
        if (filename && filename !== 'credentials.json') return
        if (this.watchDebounce) clearTimeout(this.watchDebounce)
        this.watchDebounce = setTimeout(() => {
          this.watchDebounce = null
          this.checkCredentialsFile()
        }, WATCH_DEBOUNCE_MS)
        this.watchDebounce.unref?.()
      })
      watcher.on('error', (err) => {
        logger.warn('auth', 'credentials watch failed', err)
        watcher.close()
        if (this.credentialsWatcher === watcher) this.credentialsWatcher = null
      })
      watcher.unref?.()
      this.credentialsWatcher = watcher
    } catch (err) {
      // Best effort: without a watcher the delete-to-sign-out contract only
      // applies at the next startup.
      logger.warn('auth', 'cannot watch shared credentials', err)
    }
  }

  checkCredentialsFile(): void {
    // Our own store writes/removals must not loop back into a sign-out.
    if (this.persisting || !this.credentialsFileLoaded) return
    if (this.accounts.length === 0 && !this.pendingToken) return
    if (existsSync(credentialsFile())) return
    // Another session (or the user) deleted the file: drop every in-memory
    // profile and secret too, without re-deleting corrupt backups.
    logger.warn('auth', 'shared credentials removed externally; signing out this session')
    this.epoch += 1
    this.clearRetry()
    const accountIds = this.accounts.map((account) => account.id)
    for (const listener of this.credentialsUnavailableListeners) {
      try {
        listener(accountIds)
      } catch (error) {
        logger.warn('auth', 'account-bound task reconciliation failed', error)
      }
    }
    this.clearCredentialsMemory()
    this.credentialsFileLoaded = false
    this.client.invalidateCache()
    this.setState({ status: 'signedOut' })
  }

  /** Periodic whoAmI while signed in, so a token revoked mid-run is detected. */
  private scheduleRevalidate(): void {
    if (this.revalidateTimer) clearTimeout(this.revalidateTimer)
    this.revalidateTimer = setTimeout(
      () => {
        void this.revalidate()
      },
      REVALIDATE_MS + Math.random() * REVALIDATE_JITTER_MS
    )
    this.revalidateTimer.unref?.()
  }

  private clearRevalidate(): void {
    if (this.revalidateTimer) clearTimeout(this.revalidateTimer)
    this.revalidateTimer = null
  }

  private async revalidate(): Promise<void> {
    const active = this.activeAccount()
    if (
      this.state.status !== 'signedIn' ||
      (active?.invalid ?? false) ||
      (!active && !this.pendingToken)
    )
      return
    if (this.revalidateInFlight) {
      this.scheduleRevalidate()
      return
    }
    this.revalidateInFlight = true
    const startEpoch = this.epoch
    try {
      await this.client.whoAmI()
    } catch (err) {
      if (this.epoch === startEpoch && isUnauthorized(err)) {
        logger.warn('auth', 'session token was revoked; signing out')
        await this.signOut()
        return
      }
      // Transient (network/5xx/403): keep the session and try again next cycle.
    } finally {
      this.revalidateInFlight = false
    }
    if (this.epoch === startEpoch && this.state.status === 'signedIn') this.scheduleRevalidate()
  }

  /**
   * Sign in with a pasted User Access Token. The candidate is validated with
   * an out-of-band, deadline-bounded whoAmI and NOTHING is touched until it
   * proves valid: a failed, slow, or hung paste leaves the current session
   * and the shared credentials file exactly as they were.
   */
  async signInWithToken(raw: string): Promise<TokenSignInResult> {
    const accessToken = raw.trim()
    if (!accessToken) return { ok: false, error: 'invalid' }
    const startEpoch = this.epoch
    let validated: { user: UserProfile; tokenDisplayName?: string; tokenRole?: string }
    try {
      validated = await this.client.whoAmIWithToken(accessToken)
    } catch (err) {
      // 'invalid' only on a definitive 401; a 403 (WAF/geo/proxy block) does
      // not condemn the token.
      return {
        ok: false,
        error: isUnauthorized(err) ? 'invalid' : isForbidden(err) ? 'forbidden' : 'network'
      }
    }
    if (this.epoch !== startEpoch) {
      // The user signed out (or in) mid-validation; that newer intent owns
      // the session — discard the candidate without touching anything.
      return { ok: false, error: 'network' }
    }
    this.epoch += 1
    this.clearRetry()
    const now = new Date().toISOString()
    const endpoint = this.currentEndpoint()
    const existing = this.accounts.find(
      (account) => account.accessToken === accessToken && account.endpoint === endpoint
    )
    const nextAccount: AccountCredential = existing
      ? (() => {
          const { invalid: _invalid, ...validAccount } = existing
          return {
            ...validAccount,
            user: validated.user,
            ...(validated.tokenDisplayName === undefined
              ? {}
              : { tokenDisplayName: validated.tokenDisplayName }),
            ...(validated.tokenRole === undefined ? {} : { tokenRole: validated.tokenRole }),
            updatedAt: now
          }
        })()
      : {
          id: randomUUID(),
          endpoint,
          user: validated.user,
          accessToken,
          ...(validated.tokenDisplayName === undefined
            ? {}
            : { tokenDisplayName: validated.tokenDisplayName }),
          ...(validated.tokenRole === undefined ? {} : { tokenRole: validated.tokenRole }),
          createdAt: now,
          updatedAt: now
        }
    const nextAccounts = existing
      ? this.accounts.map((account) => (account.id === existing.id ? nextAccount : account))
      : [...this.accounts, nextAccount]
    this.setAccounts(nextAccounts, nextAccount.id)
    this.claimLegacyLibraryRows(nextAccount.id)
    try {
      this.persistPayload({ activeAccountId: nextAccount.id, accounts: nextAccounts })
    } catch (err) {
      // Memory-only is fine for this run.
      logger.warn('auth', 'failed to persist signed-in account', err)
    }
    this.client.invalidateCache()
    this.setState(this.signedInState(validated.user))
    return { ok: true, state: this.state }
  }

  async switchAccount(accountId: string): Promise<AccountSwitchResult> {
    const selected = this.accounts.find((account) => account.id === accountId)
    if (!selected) return { ok: false, error: 'not-found', accountId }
    if (selected.invalid) return { ok: false, error: 'invalid', accountId }
    if (selected.id === this.activeAccountId && this.state.status === 'signedIn') {
      return { ok: true, state: this.state }
    }
    if (selected.endpoint !== this.currentEndpoint()) {
      return { ok: false, error: 'endpoint-mismatch', accountId, settings: 'network' }
    }

    // Advancing the intent epoch makes a newer sign-in/sign-out/switch win if
    // this out-of-band validation is still pending when that action completes.
    const startEpoch = ++this.epoch
    let validated: { user: UserProfile; tokenDisplayName?: string; tokenRole?: string }
    try {
      validated = await this.client.whoAmIWithToken(selected.accessToken)
    } catch (err) {
      if (isUnauthorized(err)) {
        const { invalid: _invalid, ...validAccount } = selected
        const invalidAccount: AccountCredential = {
          ...validAccount,
          invalid: true,
          updatedAt: new Date().toISOString()
        }
        const nextAccounts = this.accounts.map((account) =>
          account.id === selected.id ? invalidAccount : account
        )
        this.setAccounts(nextAccounts, this.activeAccountId)
        try {
          this.persistPayload({ activeAccountId: this.activeAccountId, accounts: nextAccounts })
        } catch (persistError) {
          logger.warn('auth', 'failed to persist invalid account state', persistError)
        }
        return { ok: false, error: 'invalid', accountId }
      }
      return {
        ok: false,
        error: isForbidden(err) ? 'forbidden' : 'network'
      }
    }
    if (this.epoch !== startEpoch) return { ok: false, error: 'network' }

    const { invalid: _invalid, ...validAccount } = selected
    const updated: AccountCredential = {
      ...validAccount,
      user: validated.user,
      ...(validated.tokenDisplayName === undefined
        ? {}
        : { tokenDisplayName: validated.tokenDisplayName }),
      ...(validated.tokenRole === undefined ? {} : { tokenRole: validated.tokenRole }),
      updatedAt: new Date().toISOString()
    }
    const nextAccounts = this.accounts.map((account) =>
      account.id === selected.id ? updated : account
    )
    try {
      this.persistPayload({ activeAccountId: selected.id, accounts: nextAccounts })
    } catch (err) {
      logger.warn('auth', 'failed to persist switched account', err)
    }
    this.setAccounts(nextAccounts, selected.id)
    this.claimLegacyLibraryRows(selected.id)
    this.client.invalidateCache()
    this.setState(this.signedInState(updated.user))
    return { ok: true, state: this.state }
  }

  removeAccount(accountId: string): AccountRemoveResult {
    const selected = this.accounts.find((account) => account.id === accountId)
    if (!selected) return { ok: false, error: 'not-found', accountId }
    const counts = this.accountUsageCounts(accountId)
    if (counts.total > 0) return { ok: false, error: 'account-in-use', accountId, counts }

    const wasActive = this.activeAccountId === accountId
    const nextAccounts = this.accounts.filter((account) => account.id !== accountId)
    const nextActiveAccountId = wasActive ? null : this.activeAccountId
    if (nextAccounts.length === 0) {
      try {
        this.clearPersistedCredentials()
      } catch (err) {
        logger.warn('auth', 'failed to clear persisted credentials after account removal', err)
      }
    } else {
      try {
        this.persistPayload({ activeAccountId: nextActiveAccountId, accounts: nextAccounts })
      } catch (err) {
        logger.warn('auth', 'failed to persist account removal', err)
      }
    }
    this.setAccounts(nextAccounts, nextActiveAccountId)
    if (wasActive) {
      this.epoch += 1
      this.client.invalidateCache()
      this.setState({ status: 'signedOut' })
    }
    return {
      ok: true,
      accounts: nextAccounts.map((account) => this.accountSummary(account, nextActiveAccountId)),
      state: this.state
    }
  }

  /**
   * Install a captured Hub web-session cookie as the supplemental credential.
   * Requires an existing token session (the cookie augments it, never replaces
   * it) and validates out of band with the same epoch discipline as
   * signInWithToken: nothing is touched until the cookie proves valid, and a
   * cookie that belongs to a different account than the token session is
   * rejected before persistence.
   */
  async connectHubSession(cookie: string): Promise<HubSessionConnectResult> {
    const trimmed = cookie.trim()
    const active = this.activeAccount()
    if (
      !trimmed ||
      this.state.status !== 'signedIn' ||
      !active ||
      active.invalid ||
      active.endpoint !== this.currentEndpoint()
    ) {
      return { ok: false, error: 'invalid' }
    }
    const sessionUser = active.user
    const startEpoch = this.epoch
    let validated: { user: UserProfile }
    try {
      validated = await this.client.whoAmIWithCookie(trimmed)
    } catch (err) {
      // Same 401/403 split as signInWithToken: only a definitive 401 marks
      // the cookie invalid.
      return {
        ok: false,
        error: isUnauthorized(err) ? 'invalid' : isForbidden(err) ? 'forbidden' : 'network'
      }
    }
    if (this.epoch !== startEpoch || this.state.status !== 'signedIn' || !this.activeAccount()) {
      // The user signed out (or re-signed-in) mid-validation; newer intent wins.
      return { ok: false, error: 'network' }
    }
    if (validated.user.name.toLowerCase() !== sessionUser.name.toLowerCase()) {
      return { ok: false, error: 'mismatch' }
    }
    const updated = {
      ...active,
      sessionCookie: trimmed,
      sessionUsername: validated.user.name,
      updatedAt: new Date().toISOString()
    }
    const nextAccounts = this.accounts.map((account) =>
      account.id === active.id ? updated : account
    )
    this.setAccounts(nextAccounts, active.id)
    try {
      this.persistPayload({ activeAccountId: active.id, accounts: nextAccounts })
    } catch (err) {
      // Memory-only is fine for this run (mirrors init()).
      logger.warn('auth', 'failed to persist Hub web session', err)
    }
    this.setState(this.signedInState(sessionUser))
    return { ok: true, state: this.state }
  }

  /**
   * Drop the web-session cookie, keeping the token session signed in. Also the
   * landing point when a cookie-backed call comes back 401 (cookie expired).
   */
  async disconnectHubSession(): Promise<AuthState> {
    const active = this.activeAccount()
    if (active?.sessionCookie && !active.invalid) {
      const { sessionCookie: _cookie, sessionUsername: _name, ...rest } = active
      const nextAccounts = this.accounts.map((account) =>
        account.id === active.id ? rest : account
      )
      this.setAccounts(nextAccounts, active.id)
      try {
        this.persistPayload({ activeAccountId: active.id, accounts: nextAccounts })
      } catch (err) {
        // Memory-only is fine for this run.
        logger.warn('auth', 'failed to persist Hub web-session removal', err)
      }
      if (this.state.status === 'signedIn') {
        this.setState(this.signedInState(this.state.user))
      }
    }
    return this.state
  }

  /**
   * Re-fetch whoami and broadcast the updated profile (avatar, fullname, …).
   * Soft-fails on transient errors so a successful profile save still returns
   * to the caller. Busts Chromium's HTTP cache for stable `/avatars/` URLs.
   */
  async refreshUser(): Promise<AuthState> {
    const active = this.activeAccount()
    if (this.state.status !== 'signedIn' || !active || active.invalid) return this.state
    try {
      const user = await this.client.whoAmI()
      const updated = {
        ...active,
        user: { ...user, avatarUrl: bustAvatarCache(user.avatarUrl, this.client.baseUrl) },
        updatedAt: new Date().toISOString()
      }
      const nextAccounts = this.accounts.map((account) =>
        account.id === active.id ? updated : account
      )
      this.setAccounts(nextAccounts, active.id)
      try {
        this.persistPayload({ activeAccountId: active.id, accounts: nextAccounts })
      } catch (err) {
        // Memory-only is fine for this run.
        logger.warn('auth', 'failed to persist refreshed account', err)
      }
      this.setState(this.signedInState(updated.user))
    } catch (err) {
      logger.warn('auth', 'refreshUser failed', err)
    }
    return this.state
  }

  async signOut(): Promise<SignOutResult> {
    this.epoch += 1
    this.clearRetry()
    const active = this.activeAccount()
    if (!active) {
      if (this.pendingToken) {
        this.clearCredentialsMemory()
        try {
          this.clearPersistedCredentials()
        } catch (err) {
          logger.warn('auth', 'failed to clear pending persisted credentials', err)
        }
        this.client.invalidateCache()
      }
      if (this.state.status !== 'signedOut') this.setState({ status: 'signedOut' })
      return this.state
    }
    const result = this.removeAccount(active.id)
    if (!result.ok) return result
    return result.state
  }

  dispose(): void {
    this.clearRetry()
    this.clearRevalidate()
    if (this.watchDebounce) clearTimeout(this.watchDebounce)
    this.watchDebounce = null
    this.stopCredentialsReconciliation()
    this.credentialsWatcher?.close()
    this.credentialsWatcher = null
    this.clearCredentialsMemory()
    this.credentialsFileLoaded = false
  }
}

/** Append ?v= so Chromium does not keep a stale Hub /avatars/… image. */
function bustAvatarCache(url: string | undefined, endpoint?: string | null): string | undefined {
  if (!url) return undefined
  try {
    const abs = hubRelativeUrl(url, endpoint)
    const parsed = new URL(abs)
    if (!parsed.pathname.includes('/avatars/')) return abs
    parsed.searchParams.set('v', String(Date.now()))
    return parsed.toString()
  } catch {
    return url
  }
}
