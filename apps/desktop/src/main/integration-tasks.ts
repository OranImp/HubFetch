import { randomUUID } from 'node:crypto'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { BrowserWindow, dialog, shell, type WebContents } from 'electron'
import ignore from 'ignore'
import type {
  ExportIntegrationTask,
  ExportStartRequest,
  IntegrationTask,
  RepoKind,
  UploadIntegrationTask,
  UploadSelection,
  UploadStartRequest,
  UploadRetryRequest,
  UploadWarning,
  UploadWarningCode,
  UploadTaskRecord
} from '@hubfetch/shared'
import type { NotificationService } from './notifications'
import type { AccountCredentialLease } from './auth'
import type { AccountReferenceCoordinator } from './account-references'
import { redactor } from './security/log'
import { runExport } from './integrations/export'
import {
  createRepoAndUpload,
  type UploadManifest,
  type UploadManifestFile
} from './integrations/upload'
import {
  UploadTaskManager,
  hashFile,
  computeManifestFingerprint,
  type FileHashResult
} from './upload-task-manager'

const SELECTION_TTL_MS = 15 * 60 * 1000
const TERMINAL_TTL_MS = 10 * 60 * 1000
const MAX_TERMINAL_TASKS = 20
const MAX_FILES = 10_000
const LARGE_UPLOAD_BYTES = 50 * 1024 ** 3
const HARD_SKIP_NAMES = new Set(['.git', 'node_modules', '.ds_store'])

const ROUTE_PREFIX: Record<RepoKind, string> = {
  model: '/models',
  dataset: '/datasets',
  space: '/spaces'
}

interface SelectionRecord {
  ownerId: number
  expiresAtMs: number
  publicSelection: UploadSelection
  manifest: UploadManifest
}

export interface IntegrationTaskDeps {
  accessToken: () => string | undefined
  username: () => string | undefined
  cacheDir: () => string
  broadcast: (tasks: IntegrationTask[]) => void
  notifications: NotificationService
  /** Test seams also keep filesystem/network side effects outside task-state tests. */
  selectUploadDirectory?: (owner: WebContents) => Promise<string | null>
  runUpload?: typeof createRepoAndUpload
  runExport?: typeof runExport
  revealPath?: (path: string) => void
  now?: () => number
  createId?: () => string
  activeAccountId?: () => string | null
  activeAccountLabel?: () => string | null
  leaseAccountCredential?: (accountId: string) => AccountCredentialLease
  references?: AccountReferenceCoordinator
  uploadTaskManager?: UploadTaskManager
}

function isTerminal(task: IntegrationTask): boolean {
  return task.status === 'done' || task.status === 'error' || task.status === 'canceled'
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

function isSensitivePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLowerCase()
  const name = normalized.split('/').at(-1) ?? normalized
  return (
    name.startsWith('.env') ||
    /\.(?:pem|key|p12|pfx)$/.test(name) ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)/.test(name) ||
    name.startsWith('credentials') ||
    name === '.npmrc' ||
    name === '.pypirc' ||
    name === '.netrc' ||
    /^secrets?\./.test(name) ||
    /(?:^|\/)\.ssh\//.test(normalized) ||
    /(?:^|\/)\.aws\/credentials$/.test(normalized)
  )
}

async function readIgnoreFile(root: string, name: string): Promise<string | null> {
  try {
    return await readFile(join(root, name), 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw new Error('upload.ignoreUnreadable', { cause: error })
  }
}

function isSafeUploadRelativePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\')) return false
  if (
    [...path].some((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
    })
  ) {
    return false
  }
  return path.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
}

export async function scanUploadFolder(rootPath: string): Promise<{
  manifest: UploadManifest
  excludedCount: number
  warnings: UploadWarning[]
  totalBytes: number
}> {
  const rootEntry = await lstat(rootPath)
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory())
    throw new Error('upload.invalidFolder')
  const rootRealPath = await realpath(rootPath)
  const rootStats = await stat(rootRealPath)
  if (!rootStats.isDirectory()) throw new Error('upload.invalidFolder')

  const matcher = ignore()
  for (const name of ['.gitignore', '.hfignore']) {
    const contents = await readIgnoreFile(rootRealPath, name)
    if (contents) matcher.add(contents)
  }

  const files: UploadManifestFile[] = []
  const sensitivePaths: string[] = []
  let sensitiveOverflow = 0
  let totalBytes = 0
  let excludedCount = 0

  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (!isSafeUploadRelativePath(rel)) throw new Error('upload.invalidPath')
      if (
        HARD_SKIP_NAMES.has(entry.name.toLowerCase()) ||
        matcher.ignores(entry.isDirectory() ? `${rel}/` : rel)
      ) {
        excludedCount++
        continue
      }
      const absolutePath = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        excludedCount++
        continue
      }
      if (entry.isDirectory()) {
        const directoryEntry = await lstat(absolutePath)
        const resolvedDirectory = await realpath(absolutePath)
        const directoryStats = await stat(resolvedDirectory)
        if (
          directoryEntry.isSymbolicLink() ||
          !directoryStats.isDirectory() ||
          !isInside(rootRealPath, resolvedDirectory)
        ) {
          throw new Error('upload.invalidFolder')
        }
        await visit(resolvedDirectory, rel)
        continue
      }
      if (!entry.isFile()) {
        // Sockets, FIFOs and devices are not ordinary upload content. Reject
        // the selection instead of silently presenting an incomplete manifest.
        throw new Error('upload.specialFile')
      }

      const fileEntry = await lstat(absolutePath)
      const resolved = await realpath(absolutePath)
      const fileStats = await stat(resolved)
      if (fileEntry.isSymbolicLink() || !fileStats.isFile() || !isInside(rootRealPath, resolved)) {
        excludedCount++
        continue
      }
      files.push({
        relativePath: rel,
        absolutePath: resolved,
        size: fileStats.size,
        mtimeMs: fileStats.mtimeMs,
        dev: fileStats.dev,
        ino: fileStats.ino
      })
      if (files.length > MAX_FILES) throw new Error('upload.tooManyFiles')
      totalBytes += fileStats.size
      if (isSensitivePath(rel)) {
        if (sensitivePaths.length < 20) sensitivePaths.push(rel)
        else sensitiveOverflow++
      }
    }
  }
  await visit(rootRealPath, '')

  const warnings: UploadWarning[] = []
  if (sensitivePaths.length > 0) {
    warnings.push({
      code: 'sensitive-path',
      paths: sensitivePaths,
      overflow: sensitiveOverflow,
      requiresAcknowledgement: true
    })
  }
  if (totalBytes > LARGE_UPLOAD_BYTES) {
    warnings.push({ code: 'large-upload', requiresAcknowledgement: true })
  }

  return {
    manifest: {
      rootPath,
      rootRealPath,
      rootDev: rootStats.dev,
      rootIno: rootStats.ino,
      files
    },
    excludedCount,
    warnings,
    totalBytes
  }
}

export class IntegrationTaskManager {
  private readonly selections = new Map<string, SelectionRecord>()
  private readonly tasks = new Map<string, IntegrationTask>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly outputPaths = new Map<string, string>()
  private readonly ownersWithSelectionCleanup = new Set<number>()
  private readonly uploadLeases = new Map<string, AccountCredentialLease>()
  private readonly uploadReferenceReleases = new Map<string, () => void>()

  constructor(private readonly deps: IntegrationTaskDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private createId(): string {
    return this.deps.createId?.() ?? randomUUID()
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString()
  }

  private ensureSelectionCleanup(owner: WebContents): void {
    if (this.ownersWithSelectionCleanup.has(owner.id)) return
    this.ownersWithSelectionCleanup.add(owner.id)
    owner.once('destroyed', () => {
      this.ownersWithSelectionCleanup.delete(owner.id)
      this.revokeSelections(owner.id)
    })
  }

  list(): IntegrationTask[] {
    this.prune()
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((task) => structuredClone(task))
  }

  async selectUploadFolder(owner: WebContents): Promise<UploadSelection | null> {
    this.prune()
    if (owner.isDestroyed?.()) return null
    this.ensureSelectionCleanup(owner)
    let rootPath: string | null | undefined
    if (this.deps.selectUploadDirectory) {
      rootPath = await this.deps.selectUploadDirectory(owner)
    } else {
      const parent = BrowserWindow.fromWebContents(owner)
      const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] }
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      rootPath = result.canceled ? undefined : result.filePaths[0]
    }
    if (!rootPath) return null

    const scanned = await scanUploadFolder(rootPath)
    if (owner.isDestroyed?.()) return null
    const selectionId = this.createId()
    const expiresAtMs = this.now() + SELECTION_TTL_MS
    const publicSelection: UploadSelection = {
      selectionId,
      label: basename(scanned.manifest.rootRealPath),
      expiresAt: new Date(expiresAtMs).toISOString(),
      fileCount: scanned.manifest.files.length,
      totalBytes: scanned.totalBytes,
      excludedCount: scanned.excludedCount,
      warnings: scanned.warnings
    }
    this.selections.set(selectionId, {
      ownerId: owner.id,
      expiresAtMs,
      publicSelection,
      manifest: scanned.manifest
    })
    return structuredClone(publicSelection)
  }

  startUpload(request: UploadStartRequest, ownerId: number): { id: string } {
    this.prune()
    if (this.hasActive('upload')) throw new Error('upload.alreadyRunning')
    const selected = this.selections.get(request.selectionId)
    if (!selected) throw new Error('upload.selectionExpired')
    if (selected.ownerId !== ownerId) throw new Error('upload.selectionExpired')
    if (selected.expiresAtMs <= this.now()) {
      this.selections.delete(request.selectionId)
      throw new Error('upload.selectionExpired')
    }
    const acknowledged = new Set<UploadWarningCode>(request.acknowledgedWarningCodes)
    const missing = selected.publicSelection.warnings.find(
      (warning) => warning.requiresAcknowledgement && !acknowledged.has(warning.code)
    )
    if (missing) throw new Error(`upload.warningNotAcknowledged:${missing.code}`)
    const id = this.createId()
    const now = this.timestamp()
    const username = this.deps.username()
    const accountId = this.deps.activeAccountId?.() ?? null
    const lease = accountId ? this.deps.leaseAccountCredential?.(accountId) : undefined
    if (accountId && !lease) throw new Error('account-unavailable')
    const accountLabel = this.deps.activeAccountLabel?.() ?? undefined
    this.selections.delete(request.selectionId)
    const task: UploadIntegrationTask = {
      id,
      kind: 'upload',
      repoKind: request.kind,
      repoId: username ? `${username}/${request.name}` : undefined,
      status: 'preparing',
      phase: 'preparing',
      progress: 0,
      createdAt: now,
      updatedAt: now,
      ...(accountId === null ? {} : { accountId }),
      ...(accountLabel === undefined ? {} : { accountLabel })
    }
    const controller = new AbortController()
    this.tasks.set(id, task)
    if (lease) this.uploadLeases.set(id, lease)
    if (accountId && this.deps.references) {
      this.uploadReferenceReleases.set(
        id,
        this.deps.references.register(accountId, 'upload', id, () => {
          this.controllers.get(id)?.abort()
          this.releaseUploadReference(id)
          this.updateTask(id, {
            status: 'error',
            phase: 'error',
            messageKey: 'account-unavailable'
          })
        })
      )
    }
    this.controllers.set(id, controller)
    this.emit()

    // Persist the task immediately
    const uploadTaskManager = this.deps.uploadTaskManager
    if (uploadTaskManager) {
      uploadTaskManager.insert({
        id,
        accountId,
        accountLabel: accountLabel ?? null,
        repoKind: request.kind,
        repoName: request.name,
        repoVisibility: request.private ? 'private' : 'public',
        rootPath: selected.manifest.rootRealPath,
        manifestFingerprint: '', // filled after hashing
        warningCodes: request.acknowledgedWarningCodes,
        summaryFileCount: selected.manifest.files.length,
        summaryTotalBytes: selected.manifest.files.reduce((s, f) => s + f.size, 0),
        status: 'preparing',
        phase: 'preparing',
        progress: 0
      })
    }

    void this.executeUpload(task, request, selected.manifest, controller)
    return { id }
  }

  startExport(request: ExportStartRequest): { id: string } {
    this.prune()
    if (this.hasActive('export')) throw new Error('export.alreadyRunning')
    const id = this.createId()
    const now = this.timestamp()
    const task: ExportIntegrationTask = {
      id,
      kind: 'export',
      tool: request.tool,
      repoKind: request.kind,
      repoId: request.repoId,
      filePath: request.filePath,
      status: 'preparing',
      phase: 'preparing',
      progress: 0,
      createdAt: now,
      updatedAt: now
    }
    const controller = new AbortController()
    this.tasks.set(id, task)
    this.controllers.set(id, controller)
    this.emit()
    void this.executeExport(task, request, controller)
    return { id }
  }

  /**
   * Retry a persisted upload task. Obtains the original account by ID, rescans
   * the root, rehashes all selected files, requires identical manifest
   * fingerprint and warning acknowledgments, then calls createRepoAndUpload.
   * A 409 from the Hub (existing repo) is intentional continuation.
   */
  async retryUpload(request: UploadRetryRequest): Promise<{ id: string }> {
    this.prune()
    if (this.hasActive('upload')) throw new Error('upload.alreadyRunning')
    const uploadTaskManager = this.deps.uploadTaskManager
    if (!uploadTaskManager) throw new Error('upload.noPersistence')
    const record = uploadTaskManager.get(request.taskId)
    if (!record) throw new Error('upload.taskNotFound')
    if (
      record.status !== 'interrupted' &&
      record.status !== 'error' &&
      record.status !== 'account-unavailable'
    ) {
      throw new Error('upload.cannotRetry')
    }

    // Obtain account credential by original account ID
    const accountId = record.accountId
    const lease = accountId ? this.deps.leaseAccountCredential?.(accountId) : undefined
    if (accountId && !lease) throw new Error('account-unavailable')
    const accountLabel = record.accountLabel

    // Rescan the root with existing ignore/symlink/special-file rules
    const scanned = await scanUploadFolder(record.rootPath)
    const newManifest = scanned.manifest

    // Rehash all selected files
    const controller = new AbortController()
    const id = this.createId()
    const now = this.timestamp()
    const fileHashes: FileHashResult[] = []
    const totalFiles = newManifest.files.length
    for (let i = 0; i < totalFiles; i++) {
      controller.signal.throwIfAborted()
      const file = newManifest.files[i]!
      const contentSha256 = await hashFile(file.absolutePath)
      fileHashes.push({
        relativePath: file.relativePath,
        size: file.size,
        contentSha256
      })
    }

    // Require identical manifest fingerprint
    const newFingerprint = computeManifestFingerprint(fileHashes)
    if (newFingerprint !== record.manifestFingerprint) {
      throw new Error('upload.selectionStale')
    }

    // Verify warning acknowledgments match
    const acknowledged = new Set(record.warningCodes)
    const missing = scanned.warnings.find(
      (warning) => warning.requiresAcknowledgement && !acknowledged.has(warning.code)
    )
    if (missing) throw new Error(`upload.warningNotAcknowledged:${missing.code}`)

    const username = this.deps.username()
    const task: UploadIntegrationTask = {
      id,
      kind: 'upload',
      repoKind: record.repoKind,
      repoId: record.repoId ?? (username ? `${username}/${record.repoName}` : undefined),
      status: 'preparing',
      phase: 'hashing',
      progress: 1, // hashing already done above
      createdAt: now,
      updatedAt: now,
      ...(accountId === null ? {} : { accountId }),
      ...(accountLabel == null ? {} : { accountLabel })
    }
    this.tasks.set(id, task)
    if (lease) this.uploadLeases.set(id, lease)
    if (accountId && this.deps.references) {
      this.uploadReferenceReleases.set(
        id,
        this.deps.references.register(accountId, 'upload', id, () => {
          this.controllers.get(id)?.abort()
          this.releaseUploadReference(id)
          this.updateTask(id, {
            status: 'error',
            phase: 'error',
            messageKey: 'account-unavailable'
          })
        })
      )
    }
    this.controllers.set(id, controller)
    this.emit()

    // Persist the retry task
    uploadTaskManager.insert({
      id,
      accountId,
      accountLabel,
      repoKind: record.repoKind,
      repoName: record.repoName,
      repoVisibility: record.repoVisibility,
      rootPath: record.rootPath,
      manifestFingerprint: newFingerprint,
      warningCodes: record.warningCodes,
      summaryFileCount: newManifest.files.length,
      summaryTotalBytes: newManifest.files.reduce((s, f) => s + f.size, 0),
      status: 'running',
      phase: 'uploading',
      progress: 0.01
    })

    void this.executeUpload(task, {
      selectionId: '',
      kind: record.repoKind,
      name: record.repoName,
      private: record.repoVisibility === 'private',
      acknowledgedWarningCodes: record.warningCodes
    }, newManifest, controller)
    return { id }
  }

  /**
   * Remove a terminal persisted upload task. Only terminal states
   * (done, error, canceled, interrupted, selection-stale, account-unavailable)
   * can be removed.
   */
  removeUpload(id: string): boolean {
    const uploadTaskManager = this.deps.uploadTaskManager
    if (!uploadTaskManager) return false
    return uploadTaskManager.remove(id)
  }

  /** List all persisted upload tasks. */
  listPersistedUploads(): UploadTaskRecord[] {
    const uploadTaskManager = this.deps.uploadTaskManager
    if (!uploadTaskManager) return []
    return uploadTaskManager.list()
  }

  cancel(id: string, kind: 'upload' | 'export'): { canceled: boolean } {
    const task = this.tasks.get(id)
    if (task?.kind === kind && task.status === 'canceled') return { canceled: true }
    const controller = this.controllers.get(id)
    if (!task || task.kind !== kind || !controller || isTerminal(task)) return { canceled: false }
    controller.abort()
    this.updateTask(task.id, { status: 'canceled', phase: 'canceled' })
    if (kind === 'upload') {
      this.releaseUploadReference(id)
      this.deps.uploadTaskManager?.update(id, { status: 'canceled', phase: 'canceled' })
    }
    return { canceled: true }
  }

  revealOutput(id: string): void {
    const task = this.tasks.get(id)
    const path = this.outputPaths.get(id)
    if (!task || task.status !== 'done' || !path) throw new Error('integration.outputUnavailable')
    ;(this.deps.revealPath ?? shell.showItemInFolder)(path)
  }

  shutdown(): void {
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
    this.selections.clear()
    for (const lease of this.uploadLeases.values()) lease.release()
    this.uploadLeases.clear()
    for (const release of this.uploadReferenceReleases.values()) release()
    this.uploadReferenceReleases.clear()
  }

  private async executeUpload(
    task: UploadIntegrationTask,
    request: UploadStartRequest,
    manifest: UploadManifest,
    controller: AbortController
  ): Promise<void> {
    const uploadTaskManager = this.deps.uploadTaskManager
    const useRealUpload = !this.deps.runUpload
    try {
      // --- Hashing phase: compute SHA-256 for every selected file ---
      // Only run when using the real upload pipeline (not test seams)
      if (useRealUpload) {
        this.updateTask(task.id, { status: 'preparing', phase: 'hashing', progress: 0 })
        if (uploadTaskManager) {
          uploadTaskManager.update(task.id, { status: 'preparing', phase: 'hashing', progress: 0 })
        }
        const fileHashes: FileHashResult[] = []
        const totalFiles = manifest.files.length
        for (let i = 0; i < totalFiles; i++) {
          controller.signal.throwIfAborted()
          const file = manifest.files[i]!
          const contentSha256 = await hashFile(file.absolutePath)
          fileHashes.push({
            relativePath: file.relativePath,
            size: file.size,
            contentSha256
          })
          const progress = (i + 1) / totalFiles
          this.updateTask(task.id, { phase: 'hashing', progress })
          if (uploadTaskManager) {
            uploadTaskManager.update(task.id, { phase: 'hashing', progress })
          }
          this.emit()
        }

        // Compute manifest fingerprint
        const manifestFingerprint = computeManifestFingerprint(fileHashes)
        if (uploadTaskManager) {
          uploadTaskManager.update(task.id, { manifestFingerprint })
        }

        controller.signal.throwIfAborted()
        this.updateTask(task.id, { status: 'running', phase: 'uploading', progress: 0.01 })
        if (uploadTaskManager) {
          uploadTaskManager.update(task.id, { status: 'running', phase: 'uploading', progress: 0.01 })
        }
        this.emit()
      }

      const result = await (this.deps.runUpload ?? createRepoAndUpload)(
        { kind: request.kind, name: request.name, private: request.private, manifest },
        {
          accessToken: this.uploadLeases.get(task.id)?.accessToken ?? this.deps.accessToken(),
          username: task.repoId?.split('/')[0] ?? this.deps.username(),
          signal: controller.signal,
          onProgress: (progress) => {
            this.updateTask(task.id, {
              status: progress.phase === 'preparing' ? 'preparing' : 'running',
              phase: progress.phase,
              progress: progress.progress,
              path: progress.path
            })
            if (uploadTaskManager) {
              uploadTaskManager.update(task.id, {
                status: progress.phase === 'preparing' ? 'preparing' : 'running',
                phase: progress.phase,
                progress: progress.progress
              })
            }
          }
        }
      )
      controller.signal.throwIfAborted()
      if (!result.ok) {
        this.updateTask(task.id, {
          status: 'error',
          phase: 'error',
          progress: result.progress,
          messageKey: result.messageKey,
          params: result.params
        })
        if (uploadTaskManager) {
          uploadTaskManager.update(task.id, {
            status: 'error',
            phase: 'error',
            progress: result.progress,
            messageKey: result.messageKey,
            params: result.params
          })
        }
        this.releaseUploadReference(task.id)
        return
      }
      const completed = this.updateTask(task.id, {
        status: 'done',
        phase: 'done',
        progress: 1,
        repoId: result.repoId,
        repoUrl: result.repoUrl,
        messageKey: result.messageKey,
        params: result.params
      })
      if (uploadTaskManager) {
        uploadTaskManager.update(task.id, {
          status: 'done',
          phase: 'done',
          progress: 1,
          repoId: result.repoId,
          repoUrl: result.repoUrl,
          messageKey: result.messageKey,
          params: result.params
        })
      }
      if (!completed) return
      this.releaseUploadReference(task.id)
      this.deps.notifications.show(
        'notifications.uploadComplete',
        'notifications.uploadCompleteBody',
        { repo: result.repoId },
        `${ROUTE_PREFIX[request.kind]}/${result.repoId}`
      )
    } catch (err) {
      if (controller.signal.aborted) {
        this.updateTask(task.id, { status: 'canceled', phase: 'canceled' })
        if (uploadTaskManager) {
          uploadTaskManager.update(task.id, { status: 'canceled', phase: 'canceled' })
        }
      } else {
        const messageKey = err instanceof Error && err.message === 'selection-stale'
          ? 'upload.selectionStale'
          : 'upload.failed'
        const status = err instanceof Error && err.message === 'selection-stale'
          ? ('selection-stale' as const)
          : ('error' as const)
        this.updateTask(task.id, {
          status,
          phase: 'error',
          messageKey,
          params: messageKey === 'upload.failed'
            ? { error: redactor.redactText(err instanceof Error ? err.message : String(err)).slice(0, 200) }
            : undefined
        })
        if (uploadTaskManager) {
          uploadTaskManager.update(task.id, {
            status,
            phase: 'error',
            messageKey,
            params: messageKey === 'upload.failed'
              ? { error: redactor.redactText(err instanceof Error ? err.message : String(err)).slice(0, 200) }
              : undefined
          })
        }
      }
      this.releaseUploadReference(task.id)
    } finally {
      this.controllers.delete(task.id)
    }
  }

  private async executeExport(
    task: ExportIntegrationTask,
    request: ExportStartRequest,
    controller: AbortController
  ): Promise<void> {
    try {
      const result = await (this.deps.runExport ?? runExport)(
        request.tool,
        request.kind,
        request.repoId,
        request.filePath,
        {
          cacheDir: this.deps.cacheDir(),
          signal: controller.signal,
          onProgress: ({ phase, progress }) =>
            this.updateTask(task.id, { status: 'running', phase, progress })
        }
      )
      controller.signal.throwIfAborted()
      if (!result.ok) {
        this.updateTask(task.id, {
          status: 'error',
          phase: 'error',
          messageKey: result.messageKey,
          params: result.params
        })
        return
      }
      if (result.outputPath) this.outputPaths.set(task.id, result.outputPath)
      const completed = this.updateTask(task.id, {
        status: 'done',
        phase: 'done',
        progress: 1,
        outputLabel: result.outputLabel,
        messageKey: result.messageKey,
        params: result.params
      })
      if (!completed) return
      this.deps.notifications.show(
        'notifications.exportComplete',
        'notifications.exportCompleteBody',
        {
          name: result.outputLabel ?? request.filePath
        }
      )
    } catch (err) {
      if (controller.signal.aborted) {
        this.updateTask(task.id, { status: 'canceled', phase: 'canceled' })
      } else {
        this.updateTask(task.id, {
          status: 'error',
          phase: 'error',
          messageKey: 'export.failed',
          params: {
            error: redactor
              .redactText(err instanceof Error ? err.message : String(err))
              .slice(0, 200)
          }
        })
      }
      this.releaseUploadReference(task.id)
    } finally {
      this.controllers.delete(task.id)
    }
  }

  private hasActive(kind: IntegrationTask['kind']): boolean {
    return [...this.tasks.values()].some((task) => task.kind === kind && !isTerminal(task))
  }

  private updateTask(id: string, patch: Partial<IntegrationTask>): boolean {
    const task = this.tasks.get(id)
    if (!task || isTerminal(task)) return false
    Object.assign(task, patch, { updatedAt: this.timestamp() })
    this.emit()
    return true
  }

  accountUsage(accountId: string): number {
    return [...this.tasks.values()].filter(
      (task) => task.kind === 'upload' && task.accountId === accountId && !isTerminal(task)
    ).length
  }

  private releaseUploadReference(id: string): void {
    this.uploadReferenceReleases.get(id)?.()
    this.uploadReferenceReleases.delete(id)
    this.uploadLeases.get(id)?.release()
    this.uploadLeases.delete(id)
  }

  private revokeSelections(ownerId: number): void {
    for (const [id, selection] of this.selections) {
      if (selection.ownerId === ownerId) this.selections.delete(id)
    }
  }

  private prune(): void {
    const cutoff = this.now() - TERMINAL_TTL_MS
    for (const [id, task] of this.tasks) {
      if (isTerminal(task) && Date.parse(task.updatedAt) < cutoff) {
        if (task.kind === 'upload') this.releaseUploadReference(id)
        this.tasks.delete(id)
        this.outputPaths.delete(id)
      }
    }
    const terminal = [...this.tasks.values()]
      .filter(isTerminal)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    for (const task of terminal.slice(MAX_TERMINAL_TASKS)) {
      if (task.kind === 'upload') this.releaseUploadReference(task.id)
      this.tasks.delete(task.id)
      this.outputPaths.delete(task.id)
    }
    for (const [id, selection] of this.selections) {
      if (selection.expiresAtMs <= this.now()) this.selections.delete(id)
    }
  }

  private emit(): void {
    this.prune()
    this.deps.broadcast(this.list())
  }
}
