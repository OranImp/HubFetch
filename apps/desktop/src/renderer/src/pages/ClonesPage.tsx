import { useCallback, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CLONE_STATUSES,
  type CloneRecord,
  type CloneRequest,
  type CloneStatus
} from '@hubfetch/shared'
import { GitBranch, Plus, RefreshCw } from 'lucide-react'
import { cancelClone, openCloneDestination, removeClone, retryClone } from '@/lib/clones'
import { serializeCloneDetails } from '@/lib/clone-detail'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useToasts } from '@/components/ui/toaster'
import { CloneDetailDrawer } from '@/components/clones/CloneDetailDrawer'
import { CloneTaskCard } from '@/components/clones/CloneTaskCard'
import { RetryCloneDialog } from '@/components/clones/RetryCloneDialog'
import { useClonesQuery, CLONES_QUERY_KEY } from '@/hooks/use-clones'

type CloneFilter = CloneStatus | 'all'

type RowAction = 'cancel' | 'retry' | 'open' | 'copy' | 'view' | 'viewParent' | 'remove'

const FILTER_ORDER: readonly CloneFilter[] = ['all', ...CLONE_STATUSES]

function CloneFilterChip({
  filter,
  active,
  count,
  label,
  onSelect
}: {
  filter: CloneFilter
  active: boolean
  count: number
  label: string
  onSelect: (filter: CloneFilter) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onSelect(filter)}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
        active
          ? 'border-select/40 bg-select/15 text-select'
          : 'border-border-card bg-card-gradient text-ink-muted hover:bg-panel-2 hover:text-ink'
      )}
    >
      {label}
      <span className={cn('nums text-[11px]', active ? 'text-select' : 'text-ink-faint')}>
        {count}
      </span>
    </button>
  )
}

export function ClonesPage(): React.JSX.Element {
  const { t, i18n } = useTranslation(['clones', 'common', 'errors'])
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const push = useToasts((s) => s.push)

  const clones = useClonesQuery()
  const records = useMemo(() => clones.data ?? [], [clones.data])

  const [filter, setFilter] = useState<CloneFilter>('all')
  const [cancelTarget, setCancelTarget] = useState<CloneRecord | null>(null)
  const [removeTarget, setRemoveTarget] = useState<CloneRecord | null>(null)
  const [retryTarget, setRetryTarget] = useState<CloneRecord | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  // The URL is the source of truth for the open drawer: post-create navigation
  // (Todo 34) and row clicks both land here with ?selected=<id>.
  const selectedId = useMemo(
    () => new URLSearchParams(location.search).get('selected'),
    [location.search]
  )

  const selected = selectedId ? (records.find((r) => r.id === selectedId) ?? null) : null

  const counts = useMemo(() => {
    const map = new Map<CloneFilter, number>([['all', records.length]])
    for (const status of CLONE_STATUSES) map.set(status, 0)
    for (const record of records) map.set(record.status, (map.get(record.status) ?? 0) + 1)
    return map
  }, [records])

  const filtered = useMemo(
    () => (filter === 'all' ? records : records.filter((r) => r.status === filter)),
    [records, filter]
  )

  const applyList = useCallback(
    (next: CloneRecord[]) => queryClient.setQueryData(CLONES_QUERY_KEY, next),
    [queryClient]
  )

  const cancel = useMutation({
    mutationFn: (id: string) => cancelClone(id),
    onMutate: (id) => setBusyId(id),
    onSuccess: (next) => {
      applyList(next)
      setCancelTarget(null)
    },
    onSettled: () => setBusyId(null)
  })

  const retry = useMutation({
    mutationFn: ({ parentId, request }: { parentId: string; request: CloneRequest }) =>
      retryClone(parentId, request),
    onMutate: ({ parentId }) => setBusyId(parentId),
    onSuccess: (queued) => {
      applyList([...records.filter((r) => r.id !== queued.id), queued])
      setRetryTarget(null)
      push(t('clones:action.retryStarted'), 'success')
      navigate(`/clones?selected=${encodeURIComponent(queued.id)}`)
    },
    onSettled: () => setBusyId(null)
  })

  const remove = useMutation({
    mutationFn: (id: string) => removeClone(id),
    onMutate: (id) => setBusyId(id),
    onSuccess: (next, id) => {
      applyList(next)
      setRemoveTarget(null)
      push(t('clones:action.removeSuccess'), 'success')
      if (selectedId === id) navigate('/clones')
    },
    onSettled: () => setBusyId(null)
  })

  const openFolder = useCallback(
    (record: CloneRecord) => {
      setBusyId(record.id)
      openCloneDestination(record.id)
        .catch(() => push(t('clones:errors.openFailed'), 'error'))
        .finally(() => setBusyId(null))
    },
    [push, t]
  )

  const copyDetails = useCallback(
    (record: CloneRecord) => {
      const text = serializeCloneDetails(t, record, i18n.language)
      navigator.clipboard
        .writeText(text)
        .then(() => push(t('clones:action.copied'), 'success'))
        .catch(() => push(t('clones:errors.copyFailed'), 'error'))
    },
    [t, i18n.language, push]
  )

  const handleRowAction = useCallback(
    (action: RowAction, record: CloneRecord) => {
      switch (action) {
        case 'view':
        case 'viewParent':
          navigate(`/clones?selected=${encodeURIComponent(record.id)}`)
          break
        case 'cancel':
          setCancelTarget(record)
          break
        case 'retry':
          setRetryTarget(record)
          break
        case 'open':
          openFolder(record)
          break
        case 'copy':
          copyDetails(record)
          break
        case 'remove':
          setRemoveTarget(record)
          break
      }
    },
    [navigate, openFolder, copyDetails]
  )

  const closeDrawer = useCallback(() => navigate('/clones'), [navigate])

  let content: React.JSX.Element
  if (clones.isLoading && clones.data === undefined) {
    content = (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2.5 rounded-lg border border-border-card p-4">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-1.5 w-full" />
          </div>
        ))}
      </div>
    )
  } else if (clones.isError) {
    content = (
      <div className="flex flex-col items-center gap-3 p-8 text-center">
        <p className="max-w-72 text-[13px] text-ink-muted">{t('clones:errors.loadFailed')}</p>
        <Button size="sm" onClick={() => void clones.refetch()}>
          <RefreshCw className="size-3.5" aria-hidden />
          {t('common:retry')}
        </Button>
      </div>
    )
  } else if (records.length === 0) {
    content = (
      <EmptyState
        icon={GitBranch}
        title={t('clones:queue.emptyTitle')}
        body={t('clones:queue.emptyBody')}
        action={
          <Button size="sm" onClick={() => navigate('/clones/create')}>
            <Plus className="size-3.5" aria-hidden />
            {t('clones:queue.newClone')}
          </Button>
        }
      />
    )
  } else if (filtered.length === 0) {
    content = (
      <EmptyState
        icon={GitBranch}
        title={t('clones:filter.emptyTitle')}
        body={t('clones:filter.emptyBody')}
      />
    )
  } else {
    content = (
      <div className="flex flex-col gap-3">
        {filtered.map((record) => (
          <CloneTaskCard
            key={record.id}
            record={record}
            records={records}
            busy={busyId === record.id}
            onAction={handleRowAction}
          />
        ))}
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 p-5">
        <header className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h1 className="text-[15px] font-semibold text-ink-strong">{t('clones:queue.title')}</h1>
            {records.length > 0 && (
              <p className="nums text-[12.5px] text-ink-muted">
                {t('clones:queue.count', {
                  count: records.length,
                  defaultValue_one: '{{count}} task',
                  defaultValue_other: '{{count}} tasks'
                })}
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('clones:action.refresh')}
              onClick={() => void clones.refetch()}
              disabled={clones.isFetching}
            >
              <RefreshCw
                className={cn('size-3.5', clones.isFetching && 'animate-spin')}
                aria-hidden
              />
              {t('clones:action.refresh')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => navigate('/clones/create')}>
              <Plus className="size-3.5" aria-hidden />
              {t('clones:queue.newClone')}
            </Button>
          </div>
        </header>

        {records.length > 0 ? (
          <div
            role="group"
            aria-label={t('clones:filter.label')}
            className="flex flex-wrap items-center gap-1.5"
          >
            {FILTER_ORDER.map((value) => (
              <CloneFilterChip
                key={value}
                filter={value}
                active={filter === value}
                count={counts.get(value) ?? 0}
                label={value === 'all' ? t('clones:filter.all') : t(`clones:status.${value}`)}
                onSelect={setFilter}
              />
            ))}
          </div>
        ) : null}

        {content}
      </div>

      {selected ? (
        <CloneDetailDrawer
          record={selected}
          records={records}
          busy={busyId === selected.id}
          onClose={closeDrawer}
          onAction={handleRowAction}
        />
      ) : null}

      {/* Cancelling an active/queued clone is destructive — confirm first. */}
      <Dialog
        open={cancelTarget !== null}
        onOpenChange={(open) => (open ? undefined : setCancelTarget(null))}
      >
        <DialogContent>
          <DialogTitle className="text-[14px] font-semibold">
            {t('clones:action.cancelConfirmTitle')}
          </DialogTitle>
          <DialogDescription className="mt-2 text-[13px] text-ink-muted">
            {t('clones:action.cancelConfirmBody')}
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setCancelTarget(null)}>
              {t('common:cancel')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={busyId !== null}
              loading={busyId === cancelTarget?.id}
              onClick={() => cancelTarget && cancel.mutate(cancelTarget.id)}
            >
              {t('clones:action.cancelConfirmConfirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Removing a terminal queue record detaches it from the list — files stay. */}
      <Dialog
        open={removeTarget !== null}
        onOpenChange={(open) => (open ? undefined : setRemoveTarget(null))}
      >
        <DialogContent>
          <DialogTitle className="text-[14px] font-semibold">
            {t('clones:action.removeConfirmTitle')}
          </DialogTitle>
          <DialogDescription className="mt-2 text-[13px] text-ink-muted">
            {t('clones:action.removeConfirmBody')}
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setRemoveTarget(null)}>
              {t('common:cancel')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={busyId !== null}
              loading={busyId === removeTarget?.id}
              onClick={() => removeTarget && remove.mutate(removeTarget.id)}
            >
              {t('clones:action.removeConfirmConfirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {retryTarget ? (
        <RetryCloneDialog
          record={retryTarget}
          busy={busyId === retryTarget.id}
          onClose={() => setRetryTarget(null)}
          onConfirm={(request) => retry.mutate({ parentId: retryTarget.id, request })}
        />
      ) : null}
    </div>
  )
}
