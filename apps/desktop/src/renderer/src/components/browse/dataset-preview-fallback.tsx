import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Database, ExternalLink } from 'lucide-react'
import { hubRepoUrl, normalizeHubEndpoint } from '@hubfetch/shared'
import { invoke, openExternal } from '@/lib/ipc'
import { Button } from '@/components/ui/button'
import { PreviewTable, TableSkeleton } from '@/components/browse/preview-table'
import { useAppStore } from '@/stores/app'

export function DatasetUnavailable({ repoId }: { repoId: string }): React.JSX.Element {
  const { t } = useTranslation(['detail', 'common'])
  const endpoint = useAppStore((s) => s.settings.hubEndpoint)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <Database className="size-8 text-ink-faint" aria-hidden />
      <p className="max-w-96 text-[12.5px] text-ink-muted">
        {t('detail:datasetPreview.unavailable')}
      </p>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => openExternal(hubRepoUrl('dataset', repoId, endpoint))}
      >
        <ExternalLink className="size-3.5" aria-hidden />
        {t('common:openOnHub')}
      </Button>
    </div>
  )
}

export function DatasetSampleFallback({ repoId }: { repoId: string }): React.JSX.Element {
  const { t } = useTranslation(['detail', 'common'])
  const endpoint = useAppStore((s) => s.settings.hubEndpoint)
  const endpointKey = normalizeHubEndpoint(endpoint)
  const sample = useQuery({
    queryKey: ['datasetSampleRows', repoId, endpointKey],
    queryFn: () => invoke('hub:datasetSampleRows', { repoId }),
    retry: false
  })

  if (sample.isPending) return <TableSkeleton />
  if (sample.isError || sample.data === null || sample.data === undefined) {
    return <DatasetUnavailable repoId={repoId} />
  }
  const columns = sample.data.columns
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b bg-panel/60 px-3 py-1.5 text-[12px] text-ink-muted">
        {t('detail:datasetPreview.sampleNote', { count: sample.data.rows.length })}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <PreviewTable
          columns={columns}
          values={sample.data.rows}
          visibleIndices={columns.map((_, index) => index)}
        />
      </div>
    </div>
  )
}
