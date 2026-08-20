import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CloneRecord, CloneRequest } from '@hubfetch/shared'
import { cloneDestinationSchema } from '@hubfetch/shared'
import { FolderOpen, RefreshCw } from 'lucide-react'
import { selectDestination } from '@/lib/clones'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

export interface RetryCloneDialogProps {
  record: CloneRecord
  busy: boolean
  onClose: () => void
  onConfirm: (request: CloneRequest) => Promise<void>
}

/**
 * Retry a terminal attempt into an empty destination. Resume in place is never
 * offered. The original folder is allowed only when it is absent or empty —
 * the store's destination reservation is the final referee, and existing files
 * are never overwritten or deleted.
 */
export function RetryCloneDialog({
  record,
  busy,
  onClose,
  onConfirm
}: RetryCloneDialogProps): React.JSX.Element {
  const { t } = useTranslation('clones')
  const [destination, setDestination] = useState(record.destination)
  const [error, setError] = useState<string | null>(null)
  const inputId = useId()

  const validate = (value: string): string | null => {
    const trimmed = value.trim()
    if (!trimmed) return t('clones:action.retryError.required')
    if (!cloneDestinationSchema.safeParse(trimmed).success) {
      return t('clones:action.retryError.invalid')
    }
    return null
  }

  const pickDestination = async (): Promise<void> => {
    try {
      const selected = await selectDestination()
      if (selected === null) return
      setDestination(selected)
      setError(null)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(
        /not a regular directory/i.test(message)
          ? t('clones:destination.invalid')
          : t('clones:destination.inaccessible')
      )
    }
  }

  const submit = async (): Promise<void> => {
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
    try {
      await onConfirm(request)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      if (/not empty|nonempty|already reserved/i.test(message)) {
        setError(t('clones:destination.nonEmpty'))
      } else if (/destination/i.test(message)) {
        setError(t('clones:destination.inaccessible'))
      } else {
        setError(t('clones:errors.retryFailed'))
      }
    }
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
          <div className="flex min-w-0 items-center gap-1.5">
            <Input
              id={inputId}
              className="min-w-0 flex-1"
              value={destination}
              onChange={(e) => {
                setDestination(e.target.value)
                setError(null)
              }}
              placeholder={t('clones:action.retryDestinationPlaceholder')}
              spellCheck={false}
              aria-invalid={error !== null}
            />
            <Button
              type="button"
              variant="secondary"
              size="icon"
              className="shrink-0"
              aria-label={t('clones:destination.select')}
              disabled={busy}
              onClick={() => void pickDestination()}
            >
              <FolderOpen className="size-4" aria-hidden />
            </Button>
          </div>
          {error ? (
            <span role="alert" className="text-[12px] text-error">
              {error}
            </span>
          ) : null}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button
            variant="cta"
            size="sm"
            onClick={() => void submit()}
            disabled={busy}
            loading={busy}
          >
            <RefreshCw className="size-3.5" aria-hidden />
            {t('clones:action.retryStart')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
