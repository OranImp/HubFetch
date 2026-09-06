import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface CacheIconActionProps {
  readonly label: string
  readonly hint?: string
  readonly disabled?: boolean
  readonly onClick: () => void
  readonly testId?: string
  readonly children: React.ReactNode
}

/** Icon button with a tooltip that still explains disabled reasons. */
export function CacheIconAction({
  label,
  hint,
  disabled,
  onClick,
  testId,
  children
}: CacheIconActionProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0">
          <Button
            variant="ghost"
            size="icon"
            aria-label={label}
            disabled={disabled}
            data-testid={testId}
            onClick={onClick}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-64 text-wrap">
        {hint ?? label}
      </TooltipContent>
    </Tooltip>
  )
}
