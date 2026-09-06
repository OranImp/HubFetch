import { useId, useMemo, useState } from 'react'
import type { DownloadPlan, DownloadPlanFileRow } from '@hubfetch/shared'
import { useTranslation } from 'react-i18next'
import { formatBytes } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

interface DownloadCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The download plan to review. Null while loading or errored. */
  plan: DownloadPlan | null
  /** True while the plan is being resolved. */
  loading?: boolean
  /** Error message from plan resolution, if any. */
  error?: string
  /** Called to retry plan resolution after an error. */
  onRetry?: () => void
  /** Called with the selected file paths when the user confirms. */
  onConfirm: (paths: string[]) => void | Promise<void>
  /** True while the download is being started. */
  pending?: boolean
}

/**
 * Download-create dialog with file-plan review. Shows the resolved file tree
 * with search, selection, cached/covered labels, and proxy/account summary.
 * The plan is resolved before the dialog opens — no state is written and no
 * workers are started until the user confirms.
 */
export function DownloadCreateDialog({
  open,
  onOpenChange,
  plan,
  loading,
  error,
  onRetry,
  onConfirm,
  pending
}: DownloadCreateDialogProps): React.JSX.Element {
  const { t } = useTranslation(['downloads'])
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const searchInputId = useId()

  // Reset selection when the plan changes.
  const [lastPlanId, setLastPlanId] = useState<string | null>(null)
  if (plan && plan.planId !== lastPlanId) {
    setLastPlanId(plan.planId)
    setSearch('')
    setSelected(new Set(plan.files.map((f) => f.path)))
  }

  const filtered = useMemo(() => {
    if (!plan) return []
    if (!search.trim()) return [...plan.files]
    const lower = search.toLowerCase()
    return plan.files.filter((f) => f.path.toLowerCase().includes(lower))
  }, [plan, search])

  const toggleFile = (path: string): void => {
    const next = new Set(selected)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setSelected(next)
  }

  const selectAll = (): void => {
    if (!plan) return
    setSelected(new Set(filtered.map((f) => f.path)))
  }

  const selectNone = (): void => {
    setSelected(new Set())
  }

  const selectedFiles = useMemo(() => {
    if (!plan) return []
    return plan.files.filter((f) => selected.has(f.path))
  }, [plan, selected])

  const selectedBytes = selectedFiles.reduce((acc, f) => acc + f.size, 0)
  const selectedCount = selectedFiles.length

  const handleConfirm = (): void => {
    if (selectedCount === 0) return
    void onConfirm([...selected])
  }

  const handleOpenChange = (next: boolean): void => {
    if (!next) {
      setSearch('')
      setSelected(new Set())
      setLastPlanId(null)
    }
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogTitle className="text-[14px] font-semibold">
          {t('downloads:create.title')}
        </DialogTitle>
        <DialogDescription className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">
          {t('downloads:create.description')}
        </DialogDescription>

        {/* Loading state */}
        {loading && (
          <div className="mt-3 flex flex-col gap-3">
            <div className="flex items-center gap-2 rounded-lg border border-border-card bg-panel p-4 text-[13px] text-ink-muted">
              <span className="size-4 animate-spin rounded-full border-2 border-ink-faint border-t-ink-strong" />
              {t('downloads:create.resolving')}
            </div>
          </div>
        )}

        {/* Error state */}
        {error && !loading && (
          <div className="mt-3 flex flex-col gap-3">
            <div className="rounded-lg border border-border-card bg-panel p-4 text-[13px] text-ink-muted">
              <p className="text-error">{error}</p>
            </div>
            {onRetry && (
              <div className="flex justify-end">
                <Button variant="secondary" size="sm" onClick={onRetry}>
                  {t('downloads:create.retry')}
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Plan review */}
        {plan && !loading && !error && (
          <div className="mt-3 flex flex-col gap-3">
            {/* Summary bar */}
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border-card bg-panel px-3 py-2 text-[12px] text-ink-muted">
              <span>
                {t('downloads:create.files', { count: plan.totalFiles })}
              </span>
              <span className="text-decor" aria-hidden>·</span>
              <span>
                {t('downloads:create.totalSize', { size: formatBytes(plan.totalBytes) })}
              </span>
              {plan.accountLabel && (
                <>
                  <span className="text-decor" aria-hidden>·</span>
                  <span>
                    {t('downloads:create.account', { account: plan.accountLabel })}
                  </span>
                </>
              )}
              <span className="text-decor" aria-hidden>·</span>
              <span>
                {plan.proxy.mode === 'manual'
                  ? t('downloads:create.proxyManual', { url: plan.proxy.url })
                  : plan.proxy.mode === 'direct'
                    ? t('downloads:create.proxyDirect')
                    : t('downloads:create.proxySystem')}
              </span>
            </div>

            {/* Search */}
            <div className="flex items-center gap-2">
              <Input
                id={searchInputId}
                type="search"
                placeholder={t('downloads:create.searchPlaceholder')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 text-[12.5px]"
              />
              <Button variant="ghost" size="sm" onClick={selectAll} className="shrink-0 text-[11.5px]">
                {t('downloads:create.selectAll')}
              </Button>
              <Button variant="ghost" size="sm" onClick={selectNone} className="shrink-0 text-[11.5px]">
                {t('downloads:create.selectNone')}
              </Button>
            </div>

            {/* File list */}
            <div className="max-h-80 overflow-y-auto rounded-lg border border-border-card">
              {filtered.length === 0 ? (
                <div className="flex items-center justify-center p-6 text-[13px] text-ink-muted">
                  {t('downloads:create.noFiles')}
                </div>
              ) : (
                <div className="flex flex-col">
                  {filtered.map((file) => (
                    <FileRow
                      key={file.path}
                      file={file}
                      checked={selected.has(file.path)}
                      onToggle={() => toggleFile(file.path)}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Selection totals */}
            <div className="flex items-center justify-between text-[12px] text-ink-muted">
              <span>
                {t('downloads:create.selected', { count: selectedCount, size: formatBytes(selectedBytes) })}
              </span>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={() => handleOpenChange(false)}>
            {t('downloads:create.cancel')}
          </Button>
          <Button
            variant="cta"
            size="sm"
            disabled={selectedCount === 0 || pending || loading || !!error}
            loading={pending}
            onClick={handleConfirm}
          >
            {t('downloads:create.start', { count: selectedCount })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** One file row in the plan review list. */
function FileRow({
  file,
  checked,
  onToggle
}: {
  file: DownloadPlanFileRow
  checked: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { t } = useTranslation(['downloads'])
  const name = file.path.split('/').at(-1) ?? file.path
  const labels: string[] = []
  if (file.alreadyCached) labels.push(t('downloads:create.cached'))
  if (file.coveredByLiveTask) labels.push(t('downloads:create.covered'))

  return (
    <label className="flex items-center gap-2 border-b border-border-card px-3 py-1.5 text-[12.5px] hover:bg-panel last:border-b-0">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="size-4 shrink-0 accent-[var(--c-ink-strong)]"
      />
      <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
        {name}
      </span>
      <span className="w-16 shrink-0 text-right font-mono text-ink-faint">
        {formatBytes(file.size)}
      </span>
      {labels.length > 0 && (
        <span className="flex shrink-0 gap-1">
          {labels.map((label) => (
            <span
              key={label}
              className="rounded bg-panel px-1.5 py-0.5 text-[10px] font-medium text-ink-muted"
            >
              {label}
            </span>
          ))}
        </span>
      )}
    </label>
  )
}