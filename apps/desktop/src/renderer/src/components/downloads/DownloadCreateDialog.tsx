import { useId, useState } from 'react'
import type { DownloadProxyOverride, ProxyConfig } from '@hubfetch/shared'
import { useTranslation } from 'react-i18next'
import { resolveCreateProxy } from '@/lib/proxy'
import { ProxySelector, type ProxySelectorLabels } from '@/components/settings/ProxySelector'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

interface DownloadCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called only on Start download, with the resolved override (null = use settings default). */
  onConfirm: (override: DownloadProxyOverride | null) => void | Promise<void>
  /** The persisted settings proxy — shown as the "Use settings default" hint. */
  settingsProxy: ProxyConfig
  /** A download is already starting (disables confirm). */
  pending?: boolean
}

/**
 * Download-create options. The selection is local state and the snapshot is
 * resolved ONLY when the user confirms: nothing is written, and no IPC request
 * is touched, until Start download. "Use settings default" omits the override
 * so the manager freezes the persisted settings config; explicit modes send a
 * closed per-task override.
 */
export function DownloadCreateDialog({
  open,
  onOpenChange,
  onConfirm,
  settingsProxy,
  pending
}: DownloadCreateDialogProps): React.JSX.Element {
  const { t } = useTranslation(['downloads'])
  const [useDefault, setUseDefault] = useState(true)
  const [mode, setMode] = useState<'system' | 'direct' | 'manual'>('system')
  const [manualDraft, setManualDraft] = useState('')
  const defaultLabelId = useId()

  // Reset the local selection whenever the dialog opens fresh.
  const handleOpenChange = (next: boolean): void => {
    if (next) {
      setUseDefault(true)
      setMode('system')
      setManualDraft('')
    }
    onOpenChange(next)
  }

  const labels: ProxySelectorLabels = {
    modeLabel: t('downloads:create.modeLabel'),
    system: t('downloads:create.modeSystem'),
    direct: t('downloads:create.modeDirect'),
    manual: t('downloads:create.modeManual'),
    hintSystem: t('downloads:create.hintSystem'),
    hintDirect: t('downloads:create.hintDirect'),
    hintManual: t('downloads:create.hintManual'),
    manualLabel: t('downloads:create.manualLabel'),
    invalid: t('downloads:create.invalid')
  }

  const parsed = resolveCreateProxy({ useDefault, mode, manualUrl: manualDraft })
  // "Use settings default" resolves to null (omit-override) and is ALWAYS
  // confirmable. An explicit Manual selection that fails the shared URL
  // validation resolves to null too, which keeps confirm disabled — the
  // confirm never fires with a bad override.
  const canConfirm = (useDefault || parsed !== null) && !pending
  const defaultModeName = t(`downloads:proxyModes.${settingsProxy.mode}`)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogTitle className="text-[14px] font-semibold">
          {t('downloads:create.title')}
        </DialogTitle>
        <DialogDescription className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">
          {t('downloads:create.description')}
        </DialogDescription>

        <div className="mt-3 flex flex-col gap-3">
          <label htmlFor={defaultLabelId} className="flex cursor-pointer items-center gap-2">
            <input
              id={defaultLabelId}
              type="checkbox"
              checked={useDefault}
              onChange={(event) => setUseDefault(event.target.checked)}
              className="size-4 accent-[var(--c-ink-strong)]"
            />
            <span className="text-[13px] font-medium text-ink-strong">
              {t('downloads:create.useDefault')}
            </span>
            <span className="text-[12px] text-ink-muted">
              {t('downloads:create.useDefaultHint', { mode: defaultModeName })}
            </span>
          </label>

          {!useDefault && (
            <div className="rounded-lg border border-border-card bg-panel p-3">
              <ProxySelector
                mode={mode}
                manualDraft={manualDraft}
                onModeChange={setMode}
                onManualDraftChange={setManualDraft}
                invalid={mode === 'manual' && parsed === null}
                labels={labels}
              />
            </div>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            {t('downloads:create.cancel')}
          </Button>
          <Button
            variant="cta"
            size="sm"
            disabled={!canConfirm}
            loading={pending}
            onClick={() => {
              void onConfirm(parsed)
            }}
          >
            {t('downloads:create.start')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
