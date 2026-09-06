import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { rename, rm, writeFile } from 'node:fs/promises'
import {
  serializeDatasetPageCsv,
  serializeDatasetPageJsonl,
  type DatasetExportFormat,
  type DatasetExportPageResult,
  type DatasetRows
} from '@hubfetch/shared'

export type DatasetExportPageRequest = {
  readonly repoId: string
  readonly config: string
  readonly split: string
  readonly offset: number
  readonly length: number
  readonly format: DatasetExportFormat
}

export type DatasetExportSaveResult =
  | { readonly canceled: true }
  | {
      readonly canceled: false
      readonly filePath: string
    }

export type DatasetExportDeps = {
  readonly getDatasetRows: (
    repoId: string,
    config: string,
    split: string,
    offset: number,
    length: number
  ) => Promise<DatasetRows>
  readonly showSaveDialog: (options: {
    defaultPath: string
    filters: Array<{ name: string; extensions: string[] }>
  }) => Promise<DatasetExportSaveResult>
  readonly writeAtomic?: (path: string, contents: string) => Promise<void>
}

export async function writeFileAtomic(destination: string, contents: string): Promise<void> {
  const partial = join(dirname(destination), `.hubfetch-export-${randomUUID()}.partial`)
  try {
    await writeFile(partial, contents, 'utf8')
    await rm(destination, { force: true })
    await rename(partial, destination)
  } catch (err) {
    await rm(partial, { force: true }).catch(() => undefined)
    throw err
  }
}

function serializePage(
  format: DatasetExportFormat,
  columns: readonly string[],
  values: readonly (readonly unknown[])[]
): string {
  switch (format) {
    case 'csv':
      return serializeDatasetPageCsv(columns, values)
    case 'jsonl':
      return serializeDatasetPageJsonl(columns, values)
    default: {
      const exhaustive: never = format
      return exhaustive
    }
  }
}

function saveFilters(format: DatasetExportFormat): Array<{ name: string; extensions: string[] }> {
  switch (format) {
    case 'csv':
      return [{ name: 'CSV', extensions: ['csv'] }]
    case 'jsonl':
      return [{ name: 'JSON Lines', extensions: ['jsonl'] }]
    default: {
      const exhaustive: never = format
      return exhaustive
    }
  }
}

function defaultFileName(request: DatasetExportPageRequest): string {
  const repo = request.repoId.replaceAll('/', '-')
  return `${repo}-${request.split}.${request.format}`
}

export async function exportDatasetPage(
  request: DatasetExportPageRequest,
  deps: DatasetExportDeps
): Promise<DatasetExportPageResult> {
  try {
    const page = await deps.getDatasetRows(
      request.repoId,
      request.config,
      request.split,
      request.offset,
      request.length
    )
    const picked = await deps.showSaveDialog({
      defaultPath: defaultFileName(request),
      filters: saveFilters(request.format)
    })
    if (picked.canceled) return { status: 'canceled' }
    const cells = page.values ?? page.rows
    const contents = serializePage(request.format, page.columns, cells)
    await (deps.writeAtomic ?? writeFileAtomic)(picked.filePath, contents)
    return { status: 'saved', label: basename(picked.filePath) }
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 200)
    return { status: 'error', message }
  }
}
