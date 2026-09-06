import type { AccountUsage } from './auth'

export type AccountReferenceKind = 'download' | 'clone' | 'upload'

interface AccountReference {
  readonly accountId: string
  readonly kind: AccountReferenceKind
  readonly key: string
  readonly onUnavailable: () => void
}

/**
 * Main-process coordinator for account-bound work. The map is intentionally
 * backend-neutral so Todo 18 can replace upload references with persisted rows
 * without changing AuthManager's account-removal contract.
 */
export class AccountReferenceCoordinator {
  private readonly references = new Map<string, AccountReference>()

  register(
    accountId: string,
    kind: AccountReferenceKind,
    key: string,
    onUnavailable: () => void
  ): () => void {
    const referenceKey = `${kind}:${key}`
    this.references.set(referenceKey, { accountId, kind, key, onUnavailable })
    return () => this.release(kind, key)
  }

  release(kind: AccountReferenceKind, key: string): void {
    this.references.delete(`${kind}:${key}`)
  }

  usage(accountId: string): AccountUsage {
    const usage = { downloads: 0, clones: 0, uploads: 0 }
    for (const reference of this.references.values()) {
      if (reference.accountId !== accountId) continue
      switch (reference.kind) {
        case 'download':
          usage.downloads += 1
          break
        case 'clone':
          usage.clones += 1
          break
        case 'upload':
          usage.uploads += 1
          break
      }
    }
    return usage
  }

  markUnavailable(accountIds: readonly string[]): void {
    const wanted = new Set(accountIds)
    let firstError: unknown
    for (const reference of [...this.references.values()]) {
      if (!wanted.has(reference.accountId)) continue
      try {
        reference.onUnavailable()
      } catch (error) {
        firstError ??= error
      }
    }
    if (firstError !== undefined) throw firstError
  }

  clear(): void {
    this.references.clear()
  }
}
