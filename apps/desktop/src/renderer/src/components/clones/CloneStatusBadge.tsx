import type { CloneStatus } from '@hubfetch/shared'
import { Ban, CheckCircle2, CircleX, Clock, Loader2, TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'

const STATUS_ICON = {
  queued: Clock,
  running: Loader2,
  cancelling: CircleX,
  completed: CheckCircle2,
  failed: CircleX,
  cancelled: Ban,
  interrupted: TriangleAlert
} as const

const STATUS_VARIANT = {
  queued: 'neutral',
  running: 'select',
  cancelling: 'warning',
  completed: 'success',
  failed: 'error',
  cancelled: 'neutral',
  interrupted: 'warning'
} as const satisfies Record<CloneStatus, 'neutral' | 'select' | 'warning' | 'success' | 'error'>

/**
 * Status pill with a leading icon and the localized status word. The icon and
 * text (not the color alone) carry the meaning, so the badge stays legible in
 * grayscale, high contrast, and for screen readers.
 */
export function CloneStatusBadge({
  status,
  className
}: {
  status: CloneStatus
  className?: string
}): React.JSX.Element {
  const { t } = useTranslation('clones')
  const Icon = STATUS_ICON[status]
  return (
    <Badge
      variant={STATUS_VARIANT[status]}
      className={cn('shrink-0', status === 'running' && 'animate-pulse', className)}
      title={t(`clones:statusHint.${status}`)}
    >
      <Icon className="size-3.5" aria-hidden />
      {t(`clones:status.${status}`)}
    </Badge>
  )
}
