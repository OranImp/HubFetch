import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CloneRecord, CloneRequest } from '@hubfetch/shared'
import { cloneDestinationSchema } from '@hubfetch/shared'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

export interface RetryCloneDialogProps {
  record: CloneRecord
  busy: boolean
  onClose: () => void
  onConfirm: (request: CloneRequest) => void
}

type DestinationError = 'required' | 'same' | 'invalid' | null

/**
 * Retry a terminal attempt into a NEW EMPTY destination. Resume in place is
 * never offered; the previous attempt's folder (possibly partial) is never
 * overwritten — the UI refuses the exact previous destination and the store's
 * destination reservation is the final referee.
 */
export function RetryCloneDialog({
  record,
  busy,
  onClose,
  onConfirm
}: RetryCloneDialogProps): React.JSX.Element {
  const { t } = useTranslation('clones')
  const [destination, setDestination] = useState('')
  const [error, setError] = useState<DestinationError>(null)
  const inputId = useId()

  const validate = (value: string): DestinationError => {
    const trimmed = value.trim()
    if (!trimmed) return 'required'
    if (!cloneDestinationSchema.safeParse(trimmed).success) return 'invalid'
    if (trimmed === record.destination) return 'same'
    return null
  }

  const submit = (): void => {
    const trimmed = destination.trim()
    const found = validate(trimmed)
    if (found !== null) {
      setError(found)
      return
    }
    const request: CloneRequest = {
      kind: record.repoKind,
      id: record.repoId,
      revision: record.revision,
      transport: record.transport,
      destination: trimmed,
      auth: record.auth,
      proxy: record.proxy
    }
    onConfirm(request)
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogTitle className="text-[14px] font-semibold">
          {t('clones:action.retryTitle')}
        </DialogTitle>
        <DialogDescription className="mt-2 text-[13px] leading-relaxed text-ink-muted">
          {t('clones:action.retryBody')}
        </DialogDescription>
        <div className="mt-2 rounded-md border border-border-card bg-panel p-2 text-[12px] leading-relaxed text-ink-muted">
          {t('clones:detail.retryInfoBody')}
        </div>
        <div className="mt-4 flex flex-col gap-1.5">
          <label htmlFor={inputId} className="text-[12.5px] font-medium text-ink-strong">
            {t('clones:action.retryDestinationLabel')}
          </label>
          <Input
            id={inputId}
            value={destination}
            onChange={(e) => {
              setDestination(e.target.value)
              setError(null)
            }}
            placeholder={t('clones:action.retryDestinationPlaceholder')}
            spellCheck={false}
            aria-invalid={error !== null}
          />
          {error ? (
            <span role="alert" className="text-[12px] text-error">
              {t(`clones:action.retryError.${error}`)}
            </span>
          ) : null}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button variant="cta" size="sm" onClick={submit} disabled={busy} loading={busy}>
            <RefreshCw className="size-3.5" aria-hidden />
            {t('clones:action.retryStart')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
