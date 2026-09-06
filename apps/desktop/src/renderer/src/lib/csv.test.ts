import { describe, expect, it } from 'vitest'
import {
  encodeCsvField,
  serializeDatasetPageCsv,
  serializeDatasetPageJsonl
} from '@hubfetch/shared'
import { delimiterOf, parseCsvPreview, splitDelimitedLine, splitDelimitedRecords } from './csv'

describe('delimiterOf', () => {
  it('picks tab for .tsv and comma otherwise', () => {
    expect(delimiterOf('data.tsv')).toBe('\t')
    expect(delimiterOf('data.CSV')).toBe(',')
    expect(delimiterOf('data.txt')).toBe(',')
  })
})

describe('splitDelimitedLine', () => {
  it('splits plain and quoted fields', () => {
    expect(splitDelimitedLine('a,b,c', ',')).toEqual(['a', 'b', 'c'])
    expect(splitDelimitedLine('a,"b,c",d', ',')).toEqual(['a', 'b,c', 'd'])
    expect(splitDelimitedLine('a,"b""c",d', ',')).toEqual(['a', 'b"c', 'd'])
    expect(splitDelimitedLine('a\tb\tc', '\t')).toEqual(['a', 'b', 'c'])
  })
})

describe('splitDelimitedRecords', () => {
  it('splits on newlines outside quotes', () => {
    expect(splitDelimitedRecords('a,b\nc,d')).toEqual(['a,b', 'c,d'])
    expect(splitDelimitedRecords('a,"b\nc",d\ne,f')).toEqual(['a,"b\nc",d', 'e,f'])
  })
})

describe('parseCsvPreview', () => {
  it('builds columns and rectangular rows', () => {
    expect(parseCsvPreview('name,age\nalice,30\nbob', ',')).toEqual({
      columns: ['name', 'age'],
      rows: [
        ['alice', '30'],
        ['bob', '']
      ]
    })
  })

  it('returns an empty table for blank input', () => {
    expect(parseCsvPreview('', ',')).toEqual({ columns: [], rows: [] })
  })
})

describe('dataset page CSV/JSONL round-trip', () => {
  const columns = ['text', 'note', 'nested', 'n']
  const values: unknown[][] = [
    ['你好，世界', 'he said "hi"\r\nnext', { k: [1, 2] }, null],
    ['=cmd|calc', 'a,b', [3], 2]
  ]

  it('encodes formula-leading strings as quoted data', () => {
    expect(encodeCsvField('=1+1')).toBe("'=1+1")
    expect(encodeCsvField('+cmd')).toBe("'+cmd")
    expect(encodeCsvField('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(encodeCsvField(-3)).toBe('-3')
  })

  it('round-trips zh-CN, commas, quotes, CRLF, null, nested JSON, and formulas', () => {
    const csv = serializeDatasetPageCsv(columns, values)
    const parsed = parseCsvPreview(csv, ',')
    expect(parsed.columns).toEqual(columns)
    expect(parsed.rows[0]?.[0]).toBe('你好，世界')
    expect(parsed.rows[0]?.[1]).toBe('he said "hi"\r\nnext')
    expect(JSON.parse(parsed.rows[0]?.[2] ?? '')).toEqual({ k: [1, 2] })
    expect(parsed.rows[0]?.[3]).toBe('')
    expect(parsed.rows[1]?.[0]).toBe("'=cmd|calc")
    expect(parsed.rows[1]?.[1]).toBe('a,b')
  })

  it('keeps nested JSON and null in JSONL without flattening', () => {
    const lines = serializeDatasetPageJsonl(columns, values)
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines[0]?.text).toBe('你好，世界')
    expect(lines[0]?.nested).toEqual({ k: [1, 2] })
    expect(lines[0]?.n).toBeNull()
    expect(lines[1]?.nested).toEqual([3])
  })
})
