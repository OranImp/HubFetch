import { useTranslation } from 'react-i18next'
import { CircleAlert, ExternalLink, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { capabilityContextFromError, describeError } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/stores/app'
import { openExternal } from '@/lib/ipc'
import { hubRelativeUrl } from '@hubfetch/shared'

interface QueryErrorStateProps {
  error: unknown
  onRetry?: () => void
  title?: string
  compact?: boolean
  className?: string
}

/** Plain-language remote-data failure with an explicit recovery action. */
export function QueryErrorState({
  error,
  onRetry,
  title,
  compact = false,
  className
}: QueryErrorStateProps): React.JSX.Element {
  const { t } = useTranslation(['errors', 'common', 'auth'])
  const openSettings = useAppStore((state) => state.openSettings)
  const hubEndpoint = useAppStore((state) => state.settings.hubEndpoint)
  const capability = capabilityContextFromError(error)

  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 text-center',
        compact ? 'py-6' : 'min-h-48 py-12',
        className
      )}
    >
      <div className="flex size-10 items-center justify-center rounded-full bg-error/10 ring-1 ring-error/15">
        <CircleAlert className="size-[18px] text-error" aria-hidden />
      </div>
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-[13.5px] font-medium text-ink-strong">
          {title ?? t('errors:query.title')}
        </p>
        <p className="text-[12.5px] leading-relaxed text-ink-muted">{describeError(t, error)}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {onRetry ? (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            <RotateCcw className="size-3.5" aria-hidden />
            {t('common:retry')}
          </Button>
        ) : null}
        {capability?.code === 'session-required' ? (
          <Button variant="cta" size="sm" onClick={() => openSettings('account')}>
            {t('auth:hubSession.connect')}
          </Button>
        ) : null}
        {capability?.code === 'unauthorized' ? (
          <Button variant="cta" size="sm" onClick={() => openSettings('account')}>
            {t('auth:signIn')}
          </Button>
        ) : null}
        {capability?.code === 'forbidden' ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => openExternal(hubRelativeUrl('', hubEndpoint))}
          >
            <ExternalLink className="size-3.5" aria-hidden />
            {t('common:openOnHub')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
