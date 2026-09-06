/**
 * Deterministic, fail-closed support-bundle ZIP export (plan Todo 24).
 *
 * SIZE_OK: one module must own the whole support-bundle boundary — the exact
 * allowlist, the deterministic ZIP writer, the fixed timestamp/permission
 * constants, the log/archive budgets, and the fail-closed leak guard; splitting
 * it would scatter the serialization contract across modules. Mirrors the
 * archived src/hubfetch/diagnostics/support_bundle.py which carries the same
 * rationale.
 *
 * The archive is built from an EXACT allowlist of members — no database/WAL,
 * task payload dumps, environment dumps, screenshots, or arbitrary files can
 * ever be candidates because only the fixed member list below is serialized.
 * Every structured value and log line passes through the Todo 22 redactor and
 * the personal-path sanitizer before it reaches the archive, and every
 * serialized member is scanned for registered/pattern sentinels BEFORE the
 * final rename.
 *
 * Determinism contract (chosen once, asserted, never current-time):
 *  - ZIP member timestamps are the fixed constant `2026-01-01T00:00:00Z`;
 *  - ZIP external attributes (file permissions) are the fixed `0644` mode;
 *  - member order is exactly the allowlist order;
 *  - byte-identical rebuilds for identical inputs (the `createdAt` manifest
 *    field comes from an injected clock seam, fixed in tests).
 *
 * Fail-closed discipline: the archive is written to a uniquely named temp
 * path in the target directory and atomically renamed into place only after
 * the sentinel scan passes. On ANY failure (leak, write error, rename error,
 * cancellation, cleanup error) every temp and partial target path is removed
 * through multiple deletion mechanisms, so no secret-bearing temp archive can
 * survive.
 */
import { randomBytes } from 'node:crypto'
import { createHash } from 'node:crypto'
import { rm, stat, unlink, rename, writeFile } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import type { AppSettings, DiagnosticReport, DownloadTask } from '@hubfetch/shared'
import { sanitizePathText } from './diagnostics-env'
import { Redactor } from './security/redaction'

/** Exact archive membership, in exact writer order. Never extended. */
export const SUPPORT_BUNDLE_MEMBERS = [
  'manifest.json',
  'app.json',
  'system.json',
  'diagnostics.json',
  'settings.json',
  'tasks-summary.json',
  'logs/main.log',
  'logs/renderer.log',
  'README.txt'
] as const
export type SupportBundleMember = (typeof SUPPORT_BUNDLE_MEMBERS)[number]

/** Fixed ZIP member timestamp — a constant chosen once, never the current time. */
export const FIXED_ZIP_DATETIME = {
  year: 2026,
  month: 1,
  day: 1,
  hour: 0,
  minute: 0,
  second: 0
} as const
/** Fixed unix permissions (regular file, 0644) packed into ZIP external attrs. */
export const FIXED_ZIP_EXTERNAL_ATTRS = (0o100644 << 16) >>> 0
/** Fixed ZIP "version made by": unix (3) << 8 | deflate-required version (20). */
export const FIXED_ZIP_VERSION_MADE_BY = (3 << 8) | 20
/** Fixed ZIP "version needed to extract": 2.0 (deflate). */
export const FIXED_ZIP_VERSION_NEEDED = 20

/** Per-log member byte budget after redaction. */
export const MAX_LOG_MEMBER_BYTES = 1 << 20
/** Total archive budget (sum of all member bytes). */
export const MAX_ARCHIVE_BYTES = 5 << 20
/** Marker appended when a log member was truncated to its budget. */
export const TRUNCATION_MARKER = '... truncated for support bundle ...\n'

/** Opaque structured payload one JSON member is serialized from. */
export type BundleJson = Record<string, unknown>

/** All inputs the builder serializes; already sanitized by the service wiring. */
export interface BundleSources {
  app: BundleJson
  system: BundleJson
  diagnostics: DiagnosticReport
  settings: AppSettings
  tasks: DownloadTask[]
  mainLog: string
  rendererLog: string
}

/** IO seams so tests can inject disk-write / deletion / rename failures. */
export interface SupportBundleIo {
  writeFile(path: string, data: Buffer): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
}

const defaultIo: SupportBundleIo = {
  writeFile: (path, data) => writeFile(path, data),
  rename: (from, to) => rename(from, to),
  remove: (path) => rm(path, { force: true })
}

export interface SupportBundleResult {
  path: string
  memberCount: number
  bytesWritten: number
  members: readonly string[]
  /** sha256 of the archive bytes — deterministic evidence for fixtures. */
  digest: string
  truncatedLogs: readonly string[]
}

/** Typed fail-closed outcome for every denied export path. */
export class SupportBundleError extends Error {
  readonly code:
    | 'invalid-target'
    | 'leak'
    | 'write'
    | 'rename'
    | 'cleanup'
    | 'canceled'
    | 'archive-budget'
    | 'internal'

  constructor(code: SupportBundleError['code'], reason: string) {
    super(`support bundle error (${code}): ${reason}`)
    this.name = 'SupportBundleError'
    this.code = code
  }
}

interface BuildOptions {
  /** Fixes `manifest.createdAt` for deterministic rebuilds. */
  clock?: () => Date
  /** Redactor used on every structured value and log line. */
  redactor?: Redactor
  /** Supplies registered secret values whose presence fails the export closed. */
  leakGuard?: () => readonly string[]
  /** IO seams for write/rename/delete failure injection. */
  io?: SupportBundleIo
  /** Temp filename factory (target dir + unique suffix). */
  tempName?: (targetDir: string, targetName: string) => string
  maxLogMemberBytes?: number
  maxArchiveBytes?: number
  /** Cancellation checked between phases; aborts clean up temp and fail closed. */
  signal?: AbortSignal
  onProgress?: (percent: number, status: string, member?: string) => void
}

/**
 * Deterministic ZIP builder: fixed timestamps, fixed permissions, exact member
 * order, CRC32 + deflate (node zlib is byte-deterministic for identical input).
 */
export function buildZipBuffer(entries: readonly { name: string; data: Buffer }[]): Buffer {
  const dos = encodeDosDateTime(FIXED_ZIP_DATETIME)
  const compressed: { name: string; crc: number; csize: number; usize: number; data: Buffer }[] = []
  for (const entry of entries) {
    const data = deflateRawSync(entry.data, { level: 6 })
    compressed.push({
      name: entry.name,
      crc: crc32(entry.data),
      csize: data.length,
      usize: entry.data.length,
      data
    })
  }
  const localSizes: number[] = []
  for (const entry of compressed) {
    const name = Buffer.from(entry.name, 'utf8')
    localSizes.push(30 + name.length + entry.csize)
  }
  const directorySize = compressed.reduce(
    (acc, entry) => acc + 46 + Buffer.byteLength(entry.name, 'utf8'),
    0
  )
  const directoryOffset = localSizes.reduce((acc, size) => acc + size, 0)
  const total = directoryOffset + directorySize + 22
  const out = Buffer.alloc(total)
  let cursor = 0

  const localOffsets: number[] = []
  for (const entry of compressed) {
    localOffsets.push(cursor)
    const name = Buffer.from(entry.name, 'utf8')
    cursor = writeUint32(out, cursor, 0x04034b50) // local header signature
    cursor = writeUint16(out, cursor, FIXED_ZIP_VERSION_NEEDED)
    cursor = writeUint16(out, cursor, 0) // flags
    cursor = writeUint16(out, cursor, 8) // deflate
    cursor = writeUint16(out, cursor, dos.time)
    cursor = writeUint16(out, cursor, dos.date)
    cursor = writeUint32(out, cursor, entry.crc)
    cursor = writeUint32(out, cursor, entry.csize)
    cursor = writeUint32(out, cursor, entry.usize)
    cursor = writeUint16(out, cursor, name.length)
    cursor = writeUint16(out, cursor, 0) // extra length
    cursor = writeBytes(out, cursor, name)
    cursor = writeBytes(out, cursor, entry.data)
  }
  for (const entry of compressed) {
    const name = Buffer.from(entry.name, 'utf8')
    const offset = localOffsets.shift()
    if (offset === undefined) throw new Error('internal: central directory offset drift')
    cursor = writeUint32(out, cursor, 0x02014b50) // central directory signature
    cursor = writeUint16(out, cursor, FIXED_ZIP_VERSION_MADE_BY)
    cursor = writeUint16(out, cursor, FIXED_ZIP_VERSION_NEEDED)
    cursor = writeUint16(out, cursor, 0) // flags
    cursor = writeUint16(out, cursor, 8) // method
    cursor = writeUint16(out, cursor, dos.time)
    cursor = writeUint16(out, cursor, dos.date)
    cursor = writeUint32(out, cursor, entry.crc)
    cursor = writeUint32(out, cursor, entry.csize)
    cursor = writeUint32(out, cursor, entry.usize)
    cursor = writeUint16(out, cursor, name.length)
    cursor = writeUint16(out, cursor, 0) // extra length
    cursor = writeUint16(out, cursor, 0) // comment length
    cursor = writeUint16(out, cursor, 0) // disk number start
    cursor = writeUint16(out, cursor, 0) // internal attrs
    cursor = writeUint32(out, cursor, FIXED_ZIP_EXTERNAL_ATTRS)
    cursor = writeUint32(out, cursor, offset)
    cursor = writeBytes(out, cursor, name)
  }
  cursor = writeUint32(out, cursor, 0x06054b50) // end of central directory
  cursor = writeUint16(out, cursor, 0) // disk number
  cursor = writeUint16(out, cursor, 0) // disk with cd
  cursor = writeUint16(out, cursor, compressed.length)
  cursor = writeUint16(out, cursor, compressed.length)
  cursor = writeUint32(out, cursor, directorySize)
  cursor = writeUint32(out, cursor, directoryOffset)
  writeUint16(out, cursor, 0) // comment length
  return out
}

function encodeDosDateTime(dt: {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}): { time: number; date: number } {
  const date = ((dt.year - 1980) << 9) | (dt.month << 5) | dt.day
  const time = (dt.hour << 11) | (dt.minute << 5) | Math.floor(dt.second / 2)
  return { time, date }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

/** Standard CRC-32 (used by ZIP local/central headers). */
export function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function writeUint16(out: Buffer, at: number, value: number): number {
  out.writeUInt16LE(value, at)
  return at + 2
}

function writeUint32(out: Buffer, at: number, value: number): number {
  out.writeUInt32LE(value >>> 0, at)
  return at + 4
}

function writeBytes(out: Buffer, at: number, data: Buffer): number {
  data.copy(out, at)
  return at + data.length
}

/** JSON with deterministic (sorted) key order for byte-identical rebuilds. */
export function stableJsonStringify(value: unknown): string {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortValue(item))
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) out[key] = sortValue(record[key])
    return out
  }
  return value
}

/** Drop `undefined` object values (array holes become null, like JSON). */
function cleanUndefined(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map((item) => (item === undefined ? null : cleanUndefined(item)))
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(record)) {
      if (item === undefined) continue
      out[key] = cleanUndefined(item)
    }
    return out
  }
  return value
}

/**
 * Redactor variant that delegates to a base redactor (registry + pattern rules)
 * and strips personal paths from every string it emits. Redaction runs first
 * (secrets gone), then path sanitization (personal machine paths collapsed),
 * then the bound. Every `redactText`/`redactValue` string leaf passes through
 * both stages (virtual dispatch through Redactor).
 */
export class SanitizingRedactor extends Redactor {
  private readonly base: Redactor
  constructor(base: Redactor = new Redactor(null)) {
    super(null)
    this.base = base
  }
  override redactText(text: string): string {
    return sanitizePathText(this.base.redactText(text))
  }
}

/**
 * Build the bundle redactor: the given redactor's registry/pattern rules PLUS
 * personal-path sanitization on every string leaf.
 */
export function createBundleRedactor(base: Redactor): Redactor {
  return new SanitizingRedactor(base)
}

/**
 * Fail-closed support-bundle builder. Builds every member in memory, scans the
 * serialized bytes for sentinels, then writes + atomically finalizes the ZIP.
 * Any failure tears down the temp and partial target paths through multiple
 * deletion mechanisms.
 */
export class SupportBundleBuilder {
  private readonly redactor: Redactor
  private readonly clock: () => Date
  private readonly io: SupportBundleIo
  private readonly maxLogMemberBytes: number
  private readonly maxArchiveBytes: number
  private readonly tempName: (targetDir: string, targetName: string) => string
  private readonly signal: AbortSignal | undefined
  private readonly onProgress:
    ((percent: number, status: string, member?: string) => void) | undefined

  constructor(options: BuildOptions = {}) {
    this.redactor = options.redactor ?? new SanitizingRedactor()
    this.clock = options.clock ?? (() => new Date())
    this.io = options.io ?? defaultIo
    this.maxLogMemberBytes = options.maxLogMemberBytes ?? MAX_LOG_MEMBER_BYTES
    this.maxArchiveBytes = options.maxArchiveBytes ?? MAX_ARCHIVE_BYTES
    this.tempName = options.tempName ?? defaultTempName
    this.signal = options.signal
    this.onProgress = options.onProgress
    this.leakGuard = options.leakGuard ?? (() => [])
  }

  private readonly leakGuard: () => readonly string[]

  /** Serialize + redact one structured member. */
  private memberJson(name: SupportBundleMember, payload: BundleJson): Buffer {
    // Undefined is dropped (optional fields stay absent); the redactor would
    // otherwise normalize it to null, which strict schemas reject.
    const redacted = this.redactor.redactValue(cleanUndefined(payload)) as unknown
    return Buffer.from(stableJsonStringify(redacted), 'utf8')
  }

  /** Redact, bound, and mark one log member. */
  private memberLog(text: string): { data: Buffer; truncated: boolean } {
    const lines = text.split(/\r?\n/)
    const redacted = lines.map((line) => this.redactor.redactText(line)).join('\n')
    let truncated = false
    let encoded = Buffer.from(redacted, 'utf8')
    if (encoded.length > this.maxLogMemberBytes) {
      encoded = encoded.subarray(0, this.maxLogMemberBytes)
      encoded = Buffer.concat([encoded, Buffer.from(TRUNCATION_MARKER, 'utf8')])
      truncated = true
    }
    return { data: encoded, truncated }
  }

  private checkAbort(): void {
    if (this.signal?.aborted) {
      throw new SupportBundleError('canceled', 'export canceled')
    }
  }

  private report(percent: number, status: string, member?: string): void {
    this.onProgress?.(percent, status, member)
  }

  /**
   * Export the allowlisted archive to `target`. On any failure the archive is
   * failed closed: every temp and partial target path is removed.
   */
  async build(target: string, sources: BundleSources): Promise<SupportBundleResult> {
    this.checkAbort()
    const lastSep = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'))
    const targetParent = target.slice(0, lastSep + 1)
    if (!targetParent) {
      throw new SupportBundleError('invalid-target', `export target has no parent: ${target}`)
    }
    if (!(await pathExists(targetParent))) {
      throw new SupportBundleError(
        'invalid-target',
        `export parent is not a directory: ${targetParent}`
      )
    }
    this.report(0.05, 'Collecting support data')

    const createdAt = this.clock().toISOString()
    const truncatedLogs: string[] = []
    const members: { name: SupportBundleMember; data: Buffer }[] = []

    members.push({
      name: 'manifest.json',
      data: this.memberJson('manifest.json', { ...this.manifestPayload(createdAt) })
    })
    members.push({ name: 'app.json', data: this.memberJson('app.json', sources.app) })
    members.push({ name: 'system.json', data: this.memberJson('system.json', sources.system) })
    members.push({
      name: 'diagnostics.json',
      data: this.memberJson('diagnostics.json', sources.diagnostics as unknown as BundleJson)
    })
    members.push({
      name: 'settings.json',
      data: this.memberJson('settings.json', sources.settings as unknown as BundleJson)
    })
    members.push({
      name: 'tasks-summary.json',
      data: this.memberJson('tasks-summary.json', this.tasksPayload(sources.tasks))
    })

    const mainLog = this.memberLog(sources.mainLog)
    const rendererLog = this.memberLog(sources.rendererLog)
    if (mainLog.truncated) truncatedLogs.push('logs/main.log')
    if (rendererLog.truncated) truncatedLogs.push('logs/renderer.log')
    members.push({ name: 'logs/main.log', data: mainLog.data })
    members.push({ name: 'logs/renderer.log', data: rendererLog.data })
    members.push({ name: 'README.txt', data: Buffer.from(this.readmePayload(createdAt), 'utf8') })

    this.checkAbort()
    this.report(0.4, 'Scanning for secrets')

    // Archive budget: bound the sum of all member bytes before writing anything.
    const totalBytes = members.reduce((acc, member) => acc + member.data.length, 0)
    if (totalBytes > this.maxArchiveBytes) {
      throw new SupportBundleError(
        'archive-budget',
        `archive exceeds the ${this.maxArchiveBytes}-byte budget (${totalBytes} bytes)`
      )
    }

    // Sentinel scan on EVERY serialized member BEFORE any file is written.
    for (const member of members) {
      this.scanMember(member.name, member.data)
    }

    this.checkAbort()
    this.report(0.65, 'Writing archive')

    const temp = join(targetParent, this.tempName(targetParent, target.slice(lastSep + 1)))
    let finalized = false
    try {
      const zip = buildZipBuffer(members)
      this.checkAbort()
      try {
        await this.io.writeFile(temp, zip)
      } catch (error) {
        throw this.wrapFailure('write', error)
      }
      this.report(0.9, 'Finalizing archive')
      this.checkAbort()
      try {
        await this.finalize(temp, target)
      } catch (error) {
        throw this.wrapFailure('rename', error)
      }
      finalized = true
    } catch (error) {
      if (error instanceof SupportBundleError) throw error
      throw this.wrapFailure('internal', error)
    } finally {
      if (!finalized) {
        await this.teardown(temp, target)
      }
    }

    const data = await readFile(target)
    return {
      path: target,
      memberCount: members.length,
      bytesWritten: data.length,
      members: members.map((m) => m.name),
      digest: createHash('sha256').update(data).digest('hex'),
      truncatedLogs
    }
  }

  private manifestPayload(createdAt: string): BundleJson {
    return {
      format: 'hubfetch-support-bundle',
      schemaVersion: 1,
      createdAt,
      app: 'HubFetch',
      members: [...SUPPORT_BUNDLE_MEMBERS],
      budget: {
        maxLogMemberBytes: this.maxLogMemberBytes,
        maxArchiveBytes: this.maxArchiveBytes
      }
    }
  }

  private tasksPayload(tasks: DownloadTask[]): BundleJson {
    const MAX_TASKS = 500
    const bounded = tasks.slice(0, MAX_TASKS)
    return {
      count: tasks.length,
      active: tasks.filter((t) => t.status === 'running' || t.status === 'queued').length,
      totalBytes: tasks.reduce((acc, t) => acc + t.totalBytes, 0),
      receivedBytes: tasks.reduce((acc, t) => acc + t.receivedBytes, 0),
      tasks: bounded.map((t) => ({
        id: t.id,
        repoId: t.repoId,
        kind: t.kind,
        revision: t.revision,
        ...(t.accountId === undefined ? {} : { accountId: t.accountId }),
        ...(t.accountLabel === undefined ? {} : { accountLabel: t.accountLabel }),
        status: t.status,
        totalBytes: t.totalBytes,
        receivedBytes: t.receivedBytes,
        speedBps: t.speedBps,
        createdAt: t.createdAt,
        completedAt: t.completedAt
      }))
    }
  }

  private readmePayload(createdAt: string): string {
    return [
      'HubFetch support bundle',
      '=======================',
      '',
      `Created: ${createdAt}`,
      `Members (${SUPPORT_BUNDLE_MEMBERS.length}):`,
      ...SUPPORT_BUNDLE_MEMBERS.map((m) => `  - ${m}`),
      '',
      'Every value in this archive was redacted of registered secrets, tokens,',
      'authorization headers, cookies, and personal machine paths before export.',
      'The diagnostics.json report summarizes the readiness probes; the log',
      'members carry the redacted main-process and renderer console output.',
      'Database, WAL, cache, screenshot, and credential files are never exported.',
      ''
    ].join('\n')
  }

  /** Fail closed if any registered or pattern sentinel reached a member. */
  private scanMember(name: string, data: Buffer): void {
    const text = data.toString('utf8')
    for (const secret of this.leakGuard()) {
      if (secret !== '' && text.includes(secret)) {
        throw new SupportBundleError('leak', `a registered secret survived into member ${name}`)
      }
    }
    const patterns = [/\bhf_[A-Za-z0-9]{20,}\b/gi, /\bapi_org_[A-Za-z0-9]{20,}\b/gi]
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        throw new SupportBundleError('leak', `a token pattern survived into member ${name}`)
      }
    }
  }

  /**
   * Atomically finalize: on Windows a rename over an existing target fails, so
   * the (dialog-confirmed) previous target is removed first, then renamed.
   * A failing finalize leaves the caller to tear everything down.
   */
  private async finalize(temp: string, target: string): Promise<void> {
    try {
      await this.io.rename(temp, target)
    } catch {
      // Windows: destination exists. The save dialog already confirmed the
      // overwrite, so remove the old target and retry exactly once.
      try {
        await this.io.remove(target)
      } catch {
        /* best-effort: the retry below is authoritative */
      }
      await this.io.rename(temp, target)
    }
  }

  /** Map an operation failure to a typed fail-closed code. */
  private wrapFailure(
    operation: 'write' | 'rename' | 'internal',
    error: unknown
  ): SupportBundleError {
    if (error instanceof SupportBundleError) return error
    const message = error instanceof Error ? error.message : String(error)
    return new SupportBundleError(operation, message)
  }

  /**
   * Remove the temp archive and any partial target through multiple deletion
   * mechanisms, so even a transient deletion failure cannot leave a
   * secret-bearing temp path behind.
   */
  private async teardown(temp: string, target: string): Promise<void> {
    let cleanupFailed: string | null = null
    for (const path of [temp, target]) {
      if (!(await this.removeByAnyMeans(path))) {
        cleanupFailed = path
      }
    }
    if (cleanupFailed !== null) {
      throw new SupportBundleError('cleanup', `could not remove temp archive path ${cleanupFailed}`)
    }
  }

  /** Try every deletion mechanism; returns whether the path is gone. */
  private async removeByAnyMeans(path: string): Promise<boolean> {
    for (const attempt of [
      () => this.io.remove(path),
      () => rm(path, { force: true, maxRetries: 3, retryDelay: 100 }),
      () => unlink(path),
      () => rmSyncForce(path)
    ]) {
      try {
        await attempt()
      } catch {
        continue
      }
      if (!(await pathExists(path))) return true
    }
    return !(await pathExists(path))
  }
}

function defaultTempName(_targetDir: string, targetName: string): string {
  return `.hubfetch-bundle-${randomBytes(8).toString('hex')}.tmp-${targetName}`
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function rmSyncForce(path: string): void {
  rmSync(path, { force: true, recursive: true })
}
