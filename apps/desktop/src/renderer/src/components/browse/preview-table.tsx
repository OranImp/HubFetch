import { useTranslation } from 'react-i18next'
import { bytesToDataUri, formatParquetCell, imageMimeOfBytes } from '@/lib/parquet'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'

const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024

export function TableSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 p-3">
      <Skeleton className="h-7" />
      {Array.from({ length: 10 }, (_, i) => (
        <Skeleton key={i} className="h-6" />
      ))}
    </div>
  )
}

export function PreviewCell({
  value,
  onZoom
}: {
  value: unknown
  onZoom?: (src: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('common')
  if (value instanceof Uint8Array && value.byteLength <= MAX_THUMBNAIL_BYTES) {
    const mime = imageMimeOfBytes(value)
    if (mime) {
      const src = bytesToDataUri(value, mime)
      if (!onZoom) {
        return (
          <img
            src={src}
            alt=""
            className="max-h-16 max-w-32 rounded border border-border-card bg-white object-contain"
          />
        )
      }
      return (
        <button
          type="button"
          aria-label={t('zoomImage')}
          className="max-h-16 max-w-32 cursor-zoom-in rounded outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          onClick={() => onZoom(src)}
        >
          <img
            src={src}
            alt=""
            className="max-h-16 max-w-32 rounded border border-border-card bg-white object-contain"
          />
        </button>
      )
    }
  }
  const text = formatParquetCell(value)
  return (
    <div className="max-w-80 truncate" title={text}>
      {text}
    </div>
  )
}

export function PreviewTable({
  columns,
  values,
  visibleIndices,
  dim,
  onZoom
}: {
  columns: readonly string[]
  values: readonly (readonly unknown[])[]
  visibleIndices: readonly number[]
  dim?: boolean
  onZoom?: (src: string) => void
}): React.JSX.Element {
  return (
    <table
      className={cn(
        'w-full border-collapse font-mono text-[12px] transition-opacity duration-150',
        dim && 'opacity-60'
      )}
    >
      <thead>
        <tr>
          {visibleIndices.map((index) => {
            const col = columns[index] ?? ''
            return (
              <th
                key={`${col}-${index}`}
                className="sticky top-0 z-10 border-b border-border-card bg-panel px-3 py-2 text-left text-[11px] font-medium whitespace-nowrap text-ink-muted"
              >
                {col}
              </th>
            )
          })}
        </tr>
      </thead>
      <tbody>
        {values.map((row, i) => (
          <tr
            key={i}
            className="border-b border-border-card align-top last:border-b-0 hover:bg-panel/60"
          >
            {visibleIndices.map((index) => (
              <td key={index} className="px-3 py-1.5">
                <PreviewCell value={row[index]} onZoom={onZoom} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
