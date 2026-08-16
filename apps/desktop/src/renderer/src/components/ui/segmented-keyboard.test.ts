import { describe, expect, it } from 'vitest'
import { segmentedMoveIndex } from './segmented-keyboard'

describe('segmentedMoveIndex (radio-group keyboard navigation)', () => {
  const three = ['system', 'direct', 'manual']

  it('moves right/down and wraps around the end', () => {
    expect(segmentedMoveIndex('ArrowRight', 0, three.length)).toBe(1)
    expect(segmentedMoveIndex('ArrowRight', 1, three.length)).toBe(2)
    expect(segmentedMoveIndex('ArrowRight', 2, three.length)).toBe(0)
    expect(segmentedMoveIndex('ArrowDown', 1, three.length)).toBe(2)
  })

  it('moves left/up and wraps around the start', () => {
    expect(segmentedMoveIndex('ArrowLeft', 2, three.length)).toBe(1)
    expect(segmentedMoveIndex('ArrowLeft', 0, three.length)).toBe(2)
    expect(segmentedMoveIndex('ArrowUp', 1, three.length)).toBe(0)
  })

  it('jumps with Home and End', () => {
    expect(segmentedMoveIndex('Home', 2, three.length)).toBe(0)
    expect(segmentedMoveIndex('End', 0, three.length)).toBe(2)
  })

  it('ignores keys the control does not own', () => {
    expect(segmentedMoveIndex('Tab', 0, three.length)).toBeNull()
    expect(segmentedMoveIndex('Enter', 0, three.length)).toBeNull()
    expect(segmentedMoveIndex('a', 0, three.length)).toBeNull()
  })

  it('is a no-op with no options', () => {
    expect(segmentedMoveIndex('ArrowRight', 0, 0)).toBeNull()
    expect(segmentedMoveIndex('Home', 0, 0)).toBeNull()
  })
})
