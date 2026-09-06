import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import {
  DATASET_PREVIEW_PAGE_SIZE,
  normalizeHubEndpoint,
  type DatasetExportFormat,
  type DatasetRows
} from '@hubfetch/shared'
import { invoke } from '@/lib/ipc'
import { Button } from '@/components/ui/button'
import { Lightbox } from '@/components/ui/lightbox'
import { useToasts } from '@/components/ui/toaster'
import { DatasetPreviewChrome } from '@/components/browse/dataset-preview-chrome'
import { DatasetSampleFallback } from '@/components/browse/dataset-preview-fallback'
import { PreviewTable, TableSkeleton } from '@/components/browse/preview-table'
import {
  filterPageRowIndices,
  pageValues,
  profileCurrentPage,
  visibleColumnIndices
} from '@/lib/dataset-page'
import { useAppStore } from '@/stores/app'

const PAGE_SIZE = DATASET_PREVIEW_PAGE_SIZE

export function DatasetPreview({ repoId }: { repoId: string }): React.JSX.Element {
  const { t } = useTranslation(['detail', 'common'])
  const push = useToasts((s) => s.push)
  const endpoint = useAppStore((s) => s.settings.hubEndpoint)
  const endpointKey = normalizeHubEndpoint(endpoint)
  const [config, setConfig] = useState<string | null>(null)
  const [split, setSplit] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [filter, setFilter] = useState('')
  const [columnQuery, setColumnQuery] = useState('')
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const [lightbox, setLightbox] = useState<string>()
  const [exporting, setExporting] = useState(false)

  const splits = useQuery({
    queryKey: ['datasetSplits', repoId, endpointKey],
    queryFn: () => invoke('hub:datasetSplits', { repoId }),
    retry: false
  })

  const configs = useMemo(
    () => [...new Set((splits.data ?? []).map((s) => s.config))],
    [splits.data]
  )
  const activeConfig = config && configs.includes(config) ? config : configs[0]
  const splitOptions = useMemo(
    () => (splits.data ?? []).filter((s) => s.config === activeConfig).map((s) => s.split),
    [splits.data, activeConfig]
  )
  const activeSplit = split && splitOptions.includes(split) ? split : splitOptions[0]

  const rows = useQuery({
    queryKey: ['datasetRows', repoId, activeConfig, activeSplit, page, endpointKey],
    queryFn: () =>
      invoke('hub:datasetRows', {
        repoId,
        config: activeConfig ?? '',
        split: activeSplit ?? '',
        offset: page * PAGE_SIZE,
        length: PAGE_SIZE
      }),
    enabled: Boolean(activeConfig && activeSplit),
    placeholderData: keepPreviousData,
    retry: 1
  })

  const [lastGood, setLastGood] = useState<{ repoId: string; data: DatasetRows } | null>(null)
  if (rows.data && !rows.isPlaceholderData && rows.data !== lastGood?.data) {
    setLastGood({ repoId, data: rows.data })
  }
  const displayRows =
    rows.data ?? (rows.isError && lastGood?.repoId === repoId ? lastGood.data : undefined)

  const values = displayRows ? pageValues(displayRows) : []
  const columns = displayRows?.columns ?? []
  const visibleIndices = visibleColumnIndices(columns, hidden)
  const filteredIndices = filterPageRowIndices(values, filter, visibleIndices)
  const filteredValues = filteredIndices.map((index) => values[index] ?? [])
  const profile = profileCurrentPage(columns, values, visibleIndices)

  if (splits.isError) return <DatasetSampleFallback repoId={repoId} />
  if (splits.isPending) return <TableSkeleton />
  if (splits.data.length === 0) return <DatasetSampleFallback repoId={repoId} />
  if (rows.isError && !displayRows) return <DatasetSampleFallback repoId={repoId} />

  const from = page * PAGE_SIZE + 1
  const to = page * PAGE_SIZE + (rows.data?.rows.length ?? 0)
  const total = rows.data?.total
  const hasNext = total !== undefined ? to < total : (rows.data?.rows.length ?? 0) === PAGE_SIZE

  function toggleColumn(name: string): void {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  async function exportPage(format: DatasetExportFormat): Promise<void> {
    if (!activeConfig || !activeSplit) return
    setExporting(true)
    try {
      const result = await invoke('dataset:exportPage', {
        repoId,
        config: activeConfig,
        split: activeSplit,
        offset: page * PAGE_SIZE,
        length: PAGE_SIZE,
        format
      })
      switch (result.status) {
        case 'canceled':
          return
        case 'saved':
          push(t('datasetPreview.exportSaved', { label: result.label }), 'success')
          return
        case 'error':
          push(t('datasetPreview.exportError', { error: result.message }), 'error')
          return
        default: {
          const exhaustive: never = result
          return exhaustive
        }
      }
    } catch (err) {
      if (err instanceof Error) {
        push(t('datasetPreview.exportError', { error: err.message }), 'error')
        return
      }
      throw err
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DatasetPreviewChrome
        configs={configs}
        splitOptions={splitOptions}
        activeConfig={activeConfig}
        activeSplit={activeSplit}
        onConfig={(value) => {
          setConfig(value)
          setSplit(null)
          setPage(0)
        }}
        onSplit={(value) => {
          setSplit(value)
          setPage(0)
        }}
        filter={filter}
        onFilter={setFilter}
        columns={columns}
        columnQuery={columnQuery}
        onColumnQuery={setColumnQuery}
        hidden={hidden}
        onToggleColumn={toggleColumn}
        profile={profile}
        exporting={exporting}
        onExport={(format) => void exportPage(format)}
      />

      {rows.isError && (
        <div className="flex items-center justify-between gap-2 border-b bg-panel/60 px-3 py-1.5">
          <span className="text-[12px] text-ink-muted">{t('datasetPreview.rowsError')}</span>
          <Button
            variant="secondary"
            size="sm"
            disabled={rows.isFetching}
            onClick={() => void rows.refetch()}
          >
            {t('common:retry')}
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {rows.isPending && <TableSkeleton />}
        {displayRows && (
          <PreviewTable
            columns={columns}
            values={filteredValues}
            visibleIndices={visibleIndices}
            dim={rows.isPlaceholderData || rows.isError}
            onZoom={setLightbox}
          />
        )}
      </div>

      {displayRows && (
        <div className="flex items-center justify-between gap-2 border-t px-3 py-1.5">
          <span className="text-[12px] text-ink-muted">
            {rows.data &&
              (total !== undefined
                ? t('datasetPreview.range', { from, to, total })
                : t('datasetPreview.rangeNoTotal', { from, to }))}
          </span>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={t('datasetPreview.prev')}
              disabled={page === 0 || rows.isFetching}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              <ChevronLeft className="size-4" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={t('datasetPreview.next')}
              disabled={!hasNext || rows.isFetching}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="size-4" aria-hidden />
            </Button>
          </div>
        </div>
      )}
      <Lightbox src={lightbox} onClose={() => setLightbox(undefined)} />
    </div>
  )
}
