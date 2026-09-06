import * as ContextMenuPrimitive from '@radix-ui/react-context-menu'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export const ContextMenu = ContextMenuPrimitive.Root
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger

export function ContextMenuSeparator(
  props: ContextMenuPrimitive.ContextMenuSeparatorProps
): React.JSX.Element {
  return <ContextMenuPrimitive.Separator className="my-1 h-px bg-border" {...props} />
}

export function ContextMenuLabel({
  className,
  ...props
}: ContextMenuPrimitive.ContextMenuLabelProps): React.JSX.Element {
  return (
    <ContextMenuPrimitive.Label
      className={cn('px-2 py-1.5 text-[12px] font-medium text-ink-muted', className)}
      {...props}
    />
  )
}

export function ContextMenuContent({
  className,
  ...props
}: ContextMenuPrimitive.ContextMenuContentProps): React.JSX.Element {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        className={cn(
          'animate-pop z-50 min-w-40 rounded-lg border bg-elevated p-1 shadow-overlay',
          className
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  )
}

export type ContextMenuItemProps = ContextMenuPrimitive.ContextMenuItemProps & {
  readonly loading?: boolean
}

export function ContextMenuItem({
  className,
  loading,
  disabled,
  children,
  ...props
}: ContextMenuItemProps): React.JSX.Element {
  return (
    <ContextMenuPrimitive.Item
      className={cn(
        'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink outline-none select-none',
        'data-[highlighted]:bg-panel-2 data-[highlighted]:text-ink-strong data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className
      )}
      {...props}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
      {children}
    </ContextMenuPrimitive.Item>
  )
}
