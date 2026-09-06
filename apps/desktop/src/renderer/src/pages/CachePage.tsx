import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Boxes, Database, HardDrive, LayoutGrid, RefreshCw, ShieldCheck, X } from 'lucide-react'
import {
  cacheIssueIdOf,
  COMMIT_SHA_RE,
  staleRevisionsOf,
  type CacheActionKind,
  type CacheActionPlan,
  type CacheActionPlanRequest,
  type CacheApplyFailureReason,
  type CachedRepo,
  type CacheVerificationProgress,
  type CacheVerificationReport,
  type RepoKind
} from '@hubfetch/shared'
import { describeError } from '@/lib/errors'
import { invoke } from '@/lib/ipc'
import { formatBytes } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useToasts } from '@/components/ui/toaster'
import { useIpcEvent } from '@/hooks/use-ipc-event'
import { resolveLocale, useAppStore } from '@/stores/app'
import { CacheActionPlanDialog } from './cache/CacheActionPlanDialog'
import { CacheIconAction } from './cache/CacheIconAction'
import { CacheRepoCard } from './cache/CacheRepoCard'
import { CacheVerificationPanel } from './cache/CacheVerificationPanel'
import {
  applySuccessKey,
  isVerifyAbort,
  repairableEntriesOf,
  repairBlockReason,
  repoVerificationOf
} from './cache/cache-page-model'

const KIND_ICON: Record<RepoKind, React.ComponentType<{ className?: string }>> = {
  model: Boxes,
  dataset: Database,
  space: LayoutGrid
}

interface PendingDelete {
  repo: CachedRepo
  commitHashes: string[]
  size: number
}

interface PlanTarget {
  request: CacheActionPlanRequest
}

export function CachePage(): React.JSX.Element {
  const { t } = useTranslation(['cache', 'common', 'errors'])
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const auth = useAppStore((s) => s.auth)
  const locale = resolveLocale(settings, appInfo)
  const queryClient = useQueryClient()
  const push = useToasts((s) => s.push)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<PendingDelete | null>(null)
  const [verifyReport, setVerifyReport] = useState<CacheVerificationReport | null>(null)
  const [verifyProgress, setVerifyProgress] = useState<CacheVerificationProgress | null>(null)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [verifyCanceled, setVerifyCanceled] = useState(false)
  const [plan, setPlan] = useState<CacheActionPlan | null>(null)
  const [planTarget, setPlanTarget] = useState<PlanTarget | null>(null)
  const [planFailure, setPlanFailure] = useState<CacheApplyFailureReason | null>(null)

  const report = useQuery({
    queryKey: ['cache'],
    queryFn: () => invoke('cache:scan', undefined),
    staleTime: 5 * 60_000
  })

  const downloads = useQuery({
    queryKey: ['downloads'],
    queryFn: () => invoke('downloads:list', undefined)
  })

  const pinnedByRepo = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const task of downloads.data ?? []) {
      if (!COMMIT_SHA_RE.test(task.revision)) continue
      const key = `${task.kind}:${task.repoId}`
      let set = map.get(key)
      if (!set) map.set(key, (set = new Set()))
      set.add(task.revision)
    }
    return map
  }, [downloads.data])

  useIpcEvent(
    'evt:cacheVerification',
    useCallback((progress: CacheVerificationProgress) => {
      setVerifyProgress(progress)
    }, [])
  )

  const invalidateLibrary = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['cache'] })
    void queryClient.invalidateQueries({ queryKey: ['downloads'] })
  }

  const verify = useMutation({
    mutationFn: () => invoke('cache:verify', undefined),
    onMutate: () => {
      setVerifyError(null)
      setVerifyCanceled(false)
      setVerifyProgress({
        phase: 'scanning',
        completedRepos: 0,
        totalRepos: 0,
        verifiedBlobs: 0,
        issuesFound: 0
      })
    },
    onSuccess: (next) => {
      setVerifyReport(next)
      setVerifyProgress(null)
    },
    onError: (err) => {
      setVerifyProgress(null)
      if (isVerifyAbort(err)) {
        setVerifyCanceled(true)
        return
      }
      setVerifyError(t('cache:verifyError'))
    }
  })

  const cancelVerify = useMutation({
    mutationFn: () => invoke('cache:verifyCancel', undefined)
  })

  const deleteRevisions = useMutation({
    mutationFn: (args: PendingDelete) =>
      invoke('cache:deleteRevisions', {
        kind: args.repo.kind,
        repoId: args.repo.id,
        commitHashes: args.commitHashes
      }),
    onSuccess: (next, args) => {
      queryClient.setQueryData(['cache'], next)
      push(t('cache:deleted', { size: formatBytes(args.size) }), 'success')
      setPending(null)
    },
    onError: (err) => {
      push(err.message, 'error')
      setPending(null)
    }
  })

  const cleanPartials = useMutation({
    mutationFn: (repo: CachedRepo) =>
      invoke('cache:cleanPartials', { kind: repo.kind, repoId: repo.id }),
    onSuccess: (next, repo) => {
      queryClient.setQueryData(['cache'], next)
      push(t('cache:deleted', { size: formatBytes(repo.partialSize ?? 0) }), 'success')
    },
    onError: (err) => push(describeError(t, err), 'error')
  })

  const planAction = useMutation({
    mutationFn: (target: PlanTarget) => invoke('cache:planAction', { request: target.request }),
    onSuccess: (next) => {
      setPlan(next)
      setPlanFailure(null)
    },
    onError: (err) => push(describeError(t, err), 'error')
  })

  const applyAction = useMutation({
    mutationFn: (planId: string) => invoke('cache:applyAction', { request: { planId } }),
    onSuccess: (result) => {
      if (!result.ok) {
        setPlanFailure(result.failure?.reason ?? 'internal')
        return
      }
      const action: CacheActionKind = result.action
      push(t(`cache:${applySuccessKey(action)}`, { size: formatBytes(result.bytes) }), 'success')
      setPlan(null)
      setPlanTarget(null)
      setPlanFailure(null)
      invalidateLibrary()
      verify.mutate()
    },
    onError: (err) => push(describeError(t, err), 'error')
  })

  const openPlan = (request: CacheActionPlanRequest): void => {
    const target = { request }
    setPlanTarget(target)
    setPlanFailure(null)
    planAction.mutate(target)
  }

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const staleOf = (repo: CachedRepo): PendingDelete | null => {
    const stale = staleRevisionsOf(repo, pinnedByRepo.get(`${repo.kind}:${repo.id}`))
    if (stale.length === 0) return null
    return {
      repo,
      commitHashes: stale.map((r) => r.commitHash),
      size: stale.reduce((acc, r) => acc + r.sizeOnDisk, 0)
    }
  }

  const verifying = verify.isPending

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 p-5">
        <header className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h1 className="text-smd nums font-semibold text-ink-strong">{t('cache:title')}</h1>
            {report.data && (
              <p className="nums flex items-center gap-1.5 text-[12.5px] text-ink-muted">
                {t('cache:totalOnDisk', { size: formatBytes(report.data.totalSize) })}
                <span className="text-decor" aria-hidden>
                  ·
                </span>
                {t('cache:reposCount', { count: report.data.repos.length })}
              </p>
            )}
            {report.data && (
              <p
                data-visual-mask="path"
                className="truncate font-mono text-[11.5px] text-ink-faint"
              >
                {report.data.root}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <CacheIconAction
              label={t('cache:verify')}
              hint={t('cache:verifyTooltip')}
              disabled={verifying}
              testId="cache-verify"
              onClick={() => verify.mutate()}
            >
              <ShieldCheck className="size-4" aria-hidden />
            </CacheIconAction>
            <CacheIconAction
              label={t('cache:cancelVerify')}
              hint={t('cache:cancelVerifyTooltip')}
              disabled={!verifying}
              testId="cache-verify-cancel"
              onClick={() => cancelVerify.mutate()}
            >
              <X className="size-4" aria-hidden />
            </CacheIconAction>
            <Button
              variant="secondary"
              size="sm"
              className="shrink-0"
              loading={report.isFetching}
              onClick={() => void report.refetch()}
            >
              <RefreshCw className="size-3.5" aria-hidden />
              {report.isFetching ? t('cache:scanning') : t('cache:scan')}
            </Button>
          </div>
        </header>

        <CacheVerificationPanel
          progress={verifyProgress}
          report={verifyReport}
          error={verifyError}
          canceled={verifyCanceled}
          locale={locale}
          verifying={verifying}
          onRetry={() => verify.mutate()}
        />

        {report.isLoading && (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        )}

        {report.error !== null && (
          <div
            role="alert"
            data-testid="cache-scan-error"
            className="flex flex-col items-center gap-3 p-8 text-center"
          >
            <p className="max-w-72 text-[13px] text-ink-muted">{describeError(t, report.error)}</p>
            <Button size="sm" onClick={() => void report.refetch()}>
              {t('common:retry')}
            </Button>
            <p className="max-w-full font-mono text-[11.5px] break-all text-ink-faint">
              {report.error.message}
            </p>
          </div>
        )}

        {report.error === null && report.data?.repos.length === 0 && (
          <EmptyState
            icon={HardDrive}
            title={t('cache:empty.title')}
            body={t('cache:empty.body')}
          />
        )}

        {report.error === null &&
          report.data?.repos.map((repo) => {
            const repoKey = `${repo.kind}:${repo.id}`
            const verification = repoVerificationOf(verifyReport, repo.kind, repo.id)
            const stale = staleOf(repo)
            return (
              <CacheRepoCard
                key={repoKey}
                repo={repo}
                icon={KIND_ICON[repo.kind]}
                isOpen={expanded.has(repoKey)}
                pinnedCommits={pinnedByRepo.get(repoKey)}
                locale={locale}
                verification={verification}
                repairBlock={repairBlockReason(auth, verification?.issues)}
                stale={stale}
                cleanPending={cleanPartials.isPending}
                onToggle={() => toggle(repoKey)}
                onDeleteStale={() => stale && setPending(stale)}
                onDeleteRevision={(commitHash, size) =>
                  setPending({ repo, commitHashes: [commitHash], size })
                }
                onReveal={() =>
                  void invoke('cache:revealRepo', { kind: repo.kind, repoId: repo.id })
                }
                onCleanPartials={() => cleanPartials.mutate(repo)}
                onPrune={() =>
                  openPlan({
                    action: 'prune',
                    kind: repo.kind,
                    repoId: repo.id,
                    retainCommits: repo.revisions
                      .filter(
                        (rev) =>
                          rev.refs.length > 0 ||
                          pinnedByRepo.get(repoKey)?.has(rev.commitHash) === true
                      )
                      .map((rev) => rev.commitHash)
                  })
                }
                onRepair={() =>
                  openPlan({
                    action: 'repair',
                    kind: repo.kind,
                    repoId: repo.id,
                    issueIds: repairableEntriesOf(verification?.issues ?? []).map((issue) =>
                      cacheIssueIdOf(issue.issue, issue.path)
                    )
                  })
                }
              />
            )
          })}
      </div>

      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent>
          <DialogTitle className="text-[14px] font-semibold">
            {t('cache:confirmDelete.title', { count: pending?.commitHashes.length ?? 0 })}
          </DialogTitle>
          <DialogDescription className="mt-2 text-[13px] text-ink-muted">
            {t('cache:confirmDelete.body', { size: formatBytes(pending?.size ?? 0) })}
          </DialogDescription>
          <p className="mt-2 font-mono text-[11.5px] break-all text-ink-faint">
            {pending?.commitHashes.map((h) => h.slice(0, 10)).join(' · ')}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setPending(null)}>
              {t('common:cancel')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={deleteRevisions.isPending}
              onClick={() => pending && deleteRevisions.mutate(pending)}
            >
              {t('common:delete')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <CacheActionPlanDialog
        plan={plan}
        applying={applyAction.isPending}
        failureReason={planFailure}
        onClose={() => {
          setPlan(null)
          setPlanTarget(null)
          setPlanFailure(null)
        }}
        onApply={() => plan && applyAction.mutate(plan.planId)}
        onReplan={() => planTarget && planAction.mutate(planTarget)}
      />
    </div>
  )
}
