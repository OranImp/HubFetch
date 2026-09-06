const FORMULA_LEADING = /^[=+\-@\t\r]/

function csvCellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

export function encodeCsvField(value: unknown): string {
  const raw = csvCellText(value)
  const text = typeof value === 'string' && FORMULA_LEADING.test(raw) ? `'${raw}` : raw
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}

export function serializeDatasetPageCsv(
  columns: readonly string[],
  values: readonly (readonly unknown[])[]
): string {
  const header = columns.map((column) => encodeCsvField(column)).join(',')
  const lines = values.map((row) => columns.map((_, index) => encodeCsvField(row[index])).join(','))
  return [header, ...lines].join('\r\n')
}

export function serializeDatasetPageJsonl(
  columns: readonly string[],
  values: readonly (readonly unknown[])[]
): string {
  return values
    .map((row) => {
      const record: Record<string, unknown> = {}
      for (let i = 0; i < columns.length; i++) {
        const name = columns[i]
        if (name === undefined) continue
        record[name] = row[i] ?? null
      }
      return JSON.stringify(record)
    })
    .join('\n')
}
