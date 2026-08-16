import { useId } from 'react'
import type { ProxyMode } from '@hubfetch/shared'
import { DEFAULT_MANUAL_PROXY_URL } from '@hubfetch/shared'
import { Input } from '@/components/ui/input'
import { SegmentedControl } from '@/components/ui/SegmentedControl'

/** Localized labels the caller binds to its own namespace (settings/downloads). */
export interface ProxySelectorLabels {
  modeLabel: string
  system: string
  direct: string
  manual: string
  hintSystem: string
  hintDirect: string
  hintManual: string
  manualLabel: string
  invalid: string
}

interface ProxySelectorProps {
  mode: ProxyMode
  manualDraft: string
  onModeChange: (mode: ProxyMode) => void
  onManualDraftChange: (draft: string) => void
  /** True when Manual is active and the draft fails the SHARED URL validation. */
  invalid: boolean
  labels: ProxySelectorLabels
  /** Manual seed shown as the input placeholder (retained across mode switches). */
  seedPlaceholder?: string
  className?: string
}

const MODES: readonly ProxyMode[] = ['system', 'direct', 'manual']

/**
 * Reusable proxy-mode control: System/Direct/Manual segmented control plus a
 * Manual URL input with INLINE validation. The URL rule is the shared
 * `normalizeManualProxyUrl` (the same one the IPC schemas enforce) — the
 * renderer never re-implements validation. The Manual input is only rendered
 * while Manual is the active mode, so unrelated modes never show it.
 */
export function ProxySelector({
  mode,
  manualDraft,
  onModeChange,
  onManualDraftChange,
  invalid,
  labels,
  seedPlaceholder = DEFAULT_MANUAL_PROXY_URL,
  className
}: ProxySelectorProps): React.JSX.Element {
  const groupId = useId()
  const hintId = `${groupId}-hint`
  const inputId = `${groupId}-input`
  const errorId = `${groupId}-error`
  const hint =
    mode === 'manual'
      ? labels.hintManual
      : mode === 'direct'
        ? labels.hintDirect
        : labels.hintSystem

  return (
    <div className={className}>
      <span id={groupId} className="sr-only">
        {labels.modeLabel}
      </span>
      <SegmentedControl<ProxyMode>
        options={MODES.map((value) => ({
          value,
          label:
            value === 'system' ? labels.system : value === 'direct' ? labels.direct : labels.manual
        }))}
        value={mode}
        onChange={onModeChange}
        aria-labelledby={groupId}
        aria-describedby={hintId}
      />
      <p
        id={hintId}
        aria-live="polite"
        className="mt-1.5 text-[11.5px] leading-relaxed text-ink-faint"
      >
        {hint}
      </p>
      {mode === 'manual' && (
        <label htmlFor={inputId} className="mt-2 flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium text-ink-strong">{labels.manualLabel}</span>
          <Input
            id={inputId}
            value={manualDraft}
            placeholder={seedPlaceholder}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={invalid}
            aria-describedby={invalid ? errorId : undefined}
            onChange={(e) => onManualDraftChange(e.target.value)}
          />
          {invalid && (
            <span id={errorId} role="alert" className="text-[12px] text-error">
              {labels.invalid}
            </span>
          )}
        </label>
      )}
    </div>
  )
}
