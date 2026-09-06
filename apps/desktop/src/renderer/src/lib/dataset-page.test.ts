import { describe, expect, it } from 'vitest'
import type { DatasetRows } from '@hubfetch/shared'
import {
  filterPageRowIndices,
  inferJsonKind,
  matchingColumnNames,
  pageValues,
  profileCurrentPage,
  visibleColumnIndices
} from './dataset-page'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

describe('inferJsonKind', () => {
  it('classifies mixed JSON and media values without flattening', () => {
    expect(inferJsonKind(null)).toBe('null')
    expect(inferJsonKind(undefined)).toBe('null')
    expect(inferJsonKind(true)).toBe('boolean')
    expect(inferJsonKind(3)).toBe('number')
    expect(inferJsonKind('hi')).toBe('string')
    expect(inferJsonKind([1, { nested: true }])).toBe('array')
    expect(inferJsonKind({ a: 1, b: [2] })).toBe('object')
    expect(inferJsonKind({ src: 'https://example/x.png', height: 8, width: 8 })).toBe('media')
    expect(inferJsonKind({ path: 'a.wav', sampling_rate: 16000 })).toBe('media')
    expect(inferJsonKind(PNG)).toBe('media')
  })
})

describe('visibleColumnIndices / matchingColumnNames', () => {
  it('hides named columns and searches the column list', () => {
    const columns = ['text', 'label', 'meta']
    expect(visibleColumnIndices(columns, new Set(['label']))).toEqual([0, 2])
    expect(matchingColumnNames(columns, 'TE')).toEqual(['text'])
    expect(matchingColumnNames(columns, '')).toEqual(columns)
  })
})

describe('pageValues', () => {
  it('prefers untruncated JSON values over display strings', () => {
    const page: DatasetRows = {
      columns: ['n'],
      rows: [['1']],
      values: [[1]]
    }
    expect(pageValues(page)).toEqual([[1]])
    expect(pageValues({ columns: ['n'], rows: [['1']] })).toEqual([['1']])
  })
})

describe('filterPageRowIndices', () => {
  it('filters the current page without mutating source rows', () => {
    const values = [
      ['你好', 1, { nested: true }],
      ['world', 2, null],
      ['你好 world', 3, [1, 2]]
    ]
    const source = values.map((row) => [...row])
    expect(filterPageRowIndices(values, '你好', [0, 1, 2])).toEqual([0, 2])
    expect(filterPageRowIndices(values, 'nested', [0, 1, 2])).toEqual([0])
    expect(filterPageRowIndices(values, '', [0])).toEqual([0, 1, 2])
    expect(values).toEqual(source)
  })
})

describe('profileCurrentPage', () => {
  it('profiles visible columns on the current page only', () => {
    const columns = ['num', 'text', 'nested', 'list', 'media', 'empty']
    const values = [
      [1, 'ab', { k: 1 }, [1], { src: 'x', width: 1 }, null],
      [5, 'abcd', { k: 2 }, [1, 2], { src: 'y', width: 2 }, null],
      [null, '', null, [], PNG, '']
    ]
    const profile = profileCurrentPage(columns, values, [0, 1, 2, 3, 4, 5])
    expect(profile.maxRows).toBe(25)
    expect(profile.rowCount).toBe(3)
    const byName = Object.fromEntries(profile.columns.map((col) => [col.name, col]))
    expect(byName.num?.kinds).toEqual(['null', 'number'])
    expect(byName.num?.nullCount).toBe(1)
    expect(byName.num?.numericMin).toBe(1)
    expect(byName.num?.numericMax).toBe(5)
    expect(byName.text?.stringMinLength).toBe(0)
    expect(byName.text?.stringMaxLength).toBe(4)
    expect(byName.nested?.kinds).toEqual(['null', 'object'])
    expect(byName.list?.kinds).toEqual(['array'])
    expect(byName.media?.kinds).toEqual(['media'])
    expect(byName.empty?.nullCount).toBe(2)
  })

  it('caps distinct count at the page size and handles an empty page', () => {
    const many = Array.from({ length: 25 }, (_, i) => [i, `v${i}`])
    const full = profileCurrentPage(['id', 'label'], many, [0, 1])
    expect(full.columns[0]?.distinctCount).toBe(25)
    const empty = profileCurrentPage(['id'], [], [0])
    expect(empty.rowCount).toBe(0)
    expect(empty.columns[0]).toEqual({
      name: 'id',
      kinds: [],
      nullCount: 0,
      distinctCount: 0
    })
  })

  it('omits hidden columns from the profile', () => {
    const profile = profileCurrentPage(['keep', 'drop'], [[1, 2]], [0])
    expect(profile.columns.map((col) => col.name)).toEqual(['keep'])
  })
})
