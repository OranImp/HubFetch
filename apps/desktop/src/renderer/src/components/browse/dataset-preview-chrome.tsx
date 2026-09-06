import { useTranslation } from 'react-i18next'
import { Columns3, Download } from 'lucide-react'
import type { DatasetExportFormat } from '@hubfetch/shared'
import type { ColumnProfile, PageProfile } from '@/lib/dataset-page'
import { matchingColumnNames } from '@/lib/dataset-page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

function formatColumnProfile(
  column: ColumnProfile,
  t: (key: string, opts?: Record<string, unknown>) => string
): string {
  const parts = [
    column.kinds.join(', ') || '—',
    t('datasetPreview.profileNull', { count: column.nullCount })
  ]
  if (column.numericMin !== undefined && column.numericMax !== undefined) {
    parts.push(
      t('datasetPreview.profileNumeric', { min: column.numericMin, max: column.numericMax })
    )
  }
  if (column.stringMinLength !== undefined && column.stringMaxLength !== undefined) {
    parts.push(
      t('datasetPreview.profileString', {
        min: column.stringMinLength,
        max: column.stringMaxLength
      })
    )
  }
  parts.push(t('datasetPreview.profileDistinct', { count: column.distinctCount }))
  return `${column.name}  ${parts.join(' · ')}`
}

export function DatasetPreviewChrome({
  configs,
  splitOptions,
  activeConfig,
  activeSplit,
  onConfig,
  onSplit,
  filter,
  onFilter,
  columns,
  columnQuery,
  onColumnQuery,
  hidden,
  onToggleColumn,
  profile,
  exporting,
  onExport
}: {
  configs: readonly string[]
  splitOptions: readonly string[]
  activeConfig?: string
  activeSplit?: string
  onConfig: (value: string) => void
  onSplit: (value: string) => void
  filter: string
  onFilter: (value: string) => void
  columns: readonly string[]
  columnQuery: string
  onColumnQuery: (value: string) => void
  hidden: ReadonlySet<string>
  onToggleColumn: (name: string) => void
  profile: PageProfile
  exporting: boolean
  onExport: (format: DatasetExportFormat) => void
}): React.JSX.Element {
  const { t } = useTranslation(['detail', 'common'])
  const listed = matchingColumnNames(columns, columnQuery)
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Select value={activeConfig} onValueChange={onConfig}>
          <SelectTrigger className="min-w-32" aria-label={t('datasetPreview.config')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {configs.map((config) => (
              <SelectItem key={config} value={config}>
                {config}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={activeSplit} onValueChange={onSplit}>
          <SelectTrigger className="min-w-28" aria-label={t('datasetPreview.split')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {splitOptions.map((split) => (
              <SelectItem key={split} value={split}>
                {split}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={filter}
          onChange={(event) => onFilter(event.target.value)}
          aria-label={t('datasetPreview.filter')}
          placeholder={t('datasetPreview.filterPlaceholder')}
          className="h-8 max-w-56"
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="sm" aria-label={t('datasetPreview.columns')}>
              <Columns3 className="size-3.5" aria-hidden />
              {t('datasetPreview.columns')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56 p-2" align="start">
            <Input
              value={columnQuery}
              onChange={(event) => onColumnQuery(event.target.value)}
              aria-label={t('datasetPreview.columnSearch')}
              placeholder={t('datasetPreview.columnSearch')}
              className="mb-2 h-8"
            />
            <div className="max-h-64 overflow-auto">
              {listed.map((name) => (
                <DropdownMenuCheckboxItem
                  key={name}
                  checked={!hidden.has(name)}
                  onCheckedChange={() => onToggleColumn(name)}
                  onSelect={(event) => event.preventDefault()}
                >
                  {name}
                </DropdownMenuCheckboxItem>
              ))}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="secondary"
          size="sm"
          disabled={exporting}
          aria-label={t('datasetPreview.exportCsv')}
          onClick={() => onExport('csv')}
        >
          <Download className="size-3.5" aria-hidden />
          {t('datasetPreview.exportCsv')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={exporting}
          aria-label={t('datasetPreview.exportJsonl')}
          onClick={() => onExport('jsonl')}
        >
          <Download className="size-3.5" aria-hidden />
          {t('datasetPreview.exportJsonl')}
        </Button>
      </div>
      <div className="border-b bg-panel/60 px-3 py-1.5">
        <p className="text-[12px] text-ink-muted">{t('datasetPreview.pageScope')}</p>
        <ul className="mt-1 flex flex-col gap-0.5 font-mono text-[11px] text-ink-faint">
          {profile.columns.map((column) => (
            <li key={column.name}>{formatColumnProfile(column, t)}</li>
          ))}
        </ul>
      </div>
    </>
  )
}
