import { useRef } from 'react'
import { cn } from '@/lib/utils'
import { segmentedMoveIndex } from './segmented-keyboard'

export { segmentedMoveIndex }

export interface SegmentedControlOption<T extends string> {
  value: T
  /** Accessible label rendered inside the segment. */
  label: string
  disabled?: boolean
}

interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedControlOption<T>[]
  value: T
  onChange: (value: T) => void
  /** Accessible name of the radio group when no visible label is linked. */
  'aria-label'?: string
  /** Id of the visible label element describing the group. */
  'aria-labelledby'?: string
  className?: string
  id?: string
}

/**
 * Reusable single-select segmented control (three proxy modes, etc.).
 * Follows the WAI-ARIA radio-group pattern: each option is `role="radio"`,
 * roving tabindex keeps the selected option the only Tab stop, and Arrow
 * Left/Right (and Up/Down), Home and End move selection AND focus together.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledby,
  className,
  id
}: SegmentedControlProps<T>): React.JSX.Element {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const current = Math.max(
    0,
    options.findIndex((option) => option.value === value)
  )

  const moveTo = (index: number): void => {
    const option = options[index]
    if (!option || option.disabled) return
    onChange(option.value)
    refs.current[index]?.focus()
  }

  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledby}
      onKeyDown={(event) => {
        // Navigation is relative to the FOCUSED segment (radio-group pattern):
        // arrow keys move selection AND focus together from wherever focus sits,
        // wrapping around the ends, with Home/End jumps.
        const focusedIndex = refs.current.findIndex((element) => element === document.activeElement)
        const base = focusedIndex >= 0 ? focusedIndex : current
        const next = segmentedMoveIndex(event.key, base, options.length)
        if (next === null) return
        event.preventDefault()
        moveTo(next)
      }}
      className={cn(
        'flex w-fit max-w-full items-center gap-0.5 rounded-lg border border-border bg-panel-2 p-0.5',
        className
      )}
    >
      {options.map((option, index) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            ref={(element) => {
              refs.current[index] = element
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={option.disabled}
            tabIndex={selected ? 0 : -1}
            onClick={() => moveTo(index)}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium transition-colors duration-150 outline-none select-none',
              'focus-visible:ring-2 focus-visible:ring-focus/40',
              selected
                ? 'bg-field text-ink-strong shadow-sm ring-1 ring-border'
                : 'text-ink-muted hover:text-ink',
              option.disabled && 'cursor-not-allowed opacity-50'
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
