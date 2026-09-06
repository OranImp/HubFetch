import type { DatasetRows } from '@hubfetch/shared'

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export function parseDatasetSampleRows(html: string): DatasetRows | undefined {
  const match =
    /data-target="DatasetViewer"[^>]*data-props="([^"]*)"/.exec(html) ??
    /data-props="([^"]*)"[^>]*data-target="DatasetViewer"/.exec(html)
  if (!match) return undefined
  let sample: {
    columns?: Array<{ name?: string }>
    rows?: Array<{ cells?: Record<string, { value?: unknown }> }>
  }
  try {
    const props = JSON.parse(decodeHtmlAttribute(match[1] ?? '')) as {
      data?: { sampleData?: { sampleData?: typeof sample } }
    }
    sample = props.data?.sampleData?.sampleData ?? {}
  } catch {
    return undefined
  }
  const columns = (sample.columns ?? []).flatMap((column) => (column.name ? [column.name] : []))
  const rows = (sample.rows ?? []).map((row) =>
    columns.map((column) => {
      const value = row.cells?.[column]?.value
      if (value === undefined || value === null) return ''
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      return text.length > 500 ? `${text.slice(0, 500)}…` : text
    })
  )
  if (columns.length === 0 || rows.length === 0) return undefined
  return { columns, rows, sample: true }
}
