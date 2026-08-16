/**
 * Radio-group arrow-key navigation for the segmented control: the next index to
 * move to (selection AND focus follow the arrow, per the radio-group pattern),
 * wrapped around the ends, with Home/End jumps. Returns null for keys the
 * control does not own. Pure so it is unit-testable without a DOM.
 */
export function segmentedMoveIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return current >= count - 1 ? 0 : current + 1
    case 'ArrowLeft':
    case 'ArrowUp':
      return current <= 0 ? count - 1 : current - 1
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}
