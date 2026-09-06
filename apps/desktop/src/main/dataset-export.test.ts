import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HubClient } from '@hubfetch/hub-api'
import type { DatasetRows } from '@hubfetch/shared'
import { exportDatasetPage, writeFileAtomic } from './dataset-export'

const COLUMNS = ['text', 'note', 'nested', 'n']
const VALUES: unknown[][] = [
  ['你好，世界', 'he said "hi"\r\nnext', { k: [1, 2] }, null],
  ['=cmd|calc', 'a,b', [3], 2]
]

describe('writeFileAtomic', () => {
  const dirs: string[] = []
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('replaces the destination and leaves no partial on success', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hubfetch-export-'))
    dirs.push(dir)
    const dest = join(dir, 'page.csv')
    await writeFile(dest, 'old', 'utf8')
    await writeFileAtomic(dest, 'new')
    expect(await readFile(dest, 'utf8')).toBe('new')
    expect((await readdir(dir)).filter((name) => name.includes('.partial'))).toEqual([])
  })
})

describe('exportDatasetPage', () => {
  it('re-fetches the requested page and returns only a display label', async () => {
    const getDatasetRows = vi.fn(async (): Promise<DatasetRows> => ({
      columns: COLUMNS,
      rows: [['truncated']],
      values: VALUES
    }))
    const writeAtomic = vi.fn(async () => undefined)
    const dest = 'C:\\Users\\me\\Documents\\imdb-train.csv'
    const result = await exportDatasetPage(
      {
        repoId: 'stanfordnlp/imdb',
        config: 'plain_text',
        split: 'train',
        offset: 25,
        length: 25,
        format: 'csv'
      },
      {
        getDatasetRows,
        showSaveDialog: async () => ({ canceled: false, filePath: dest }),
        writeAtomic
      }
    )
    expect(getDatasetRows).toHaveBeenCalledWith('stanfordnlp/imdb', 'plain_text', 'train', 25, 25)
    expect(writeAtomic).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ status: 'saved', label: 'imdb-train.csv' })
    expect(JSON.stringify(result)).not.toContain('Documents')
  })

  it('re-fetches the exact visible page from a local datasets-server fixture', async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/rows')
      expect(url.searchParams.get('dataset')).toBe('fixture-owner/fixture-dataset')
      expect(url.searchParams.get('config')).toBe('default')
      expect(url.searchParams.get('split')).toBe('train')
      expect(url.searchParams.get('offset')).toBe('25')
      expect(url.searchParams.get('length')).toBe('25')
      return new Response(
        JSON.stringify({
          features: [{ name: 'text' }, { name: 'note' }],
          rows: [{ row: { text: '你好，世界', note: '=1+1' } }],
          num_rows_total: 80
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    })
    const client = new HubClient({
      fetchImpl: fetchImpl as typeof fetch,
      cacheTtlMs: 0,
      minRequestGapMs: 0
    })
    const writeAtomic = vi.fn<(path: string, contents: string) => Promise<void>>(
      async () => undefined
    )
    const result = await exportDatasetPage(
      {
        repoId: 'fixture-owner/fixture-dataset',
        config: 'default',
        split: 'train',
        offset: 25,
        length: 25,
        format: 'jsonl'
      },
      {
        getDatasetRows: (repoId, config, split, offset, length) =>
          client.getDatasetRows(repoId, config, split, offset, length),
        showSaveDialog: async () => ({ canceled: false, filePath: 'C:\\tmp\\page.jsonl' }),
        writeAtomic
      }
    )
    expect(result).toEqual({ status: 'saved', label: 'page.jsonl' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const body = writeAtomic.mock.calls[0]?.[1]
    expect(body).toBeDefined()
    expect(JSON.parse(body ?? '')).toEqual({ text: '你好，世界', note: '=1+1' })
  })

  it('writes no final file when the save dialog is canceled', async () => {
    const writeAtomic = vi.fn(async () => undefined)
    const result = await exportDatasetPage(
      {
        repoId: 'a/b',
        config: 'default',
        split: 'train',
        offset: 0,
        length: 25,
        format: 'jsonl'
      },
      {
        getDatasetRows: async () => ({ columns: ['x'], rows: [['1']], values: [[1]] }),
        showSaveDialog: async () => ({ canceled: true }),
        writeAtomic
      }
    )
    expect(result).toEqual({ status: 'canceled' })
    expect(writeAtomic).not.toHaveBeenCalled()
  })
})
