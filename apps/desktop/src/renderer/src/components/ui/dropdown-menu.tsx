import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export const DropdownMenu = DropdownPrimitive.Root
export const DropdownMenuTrigger = DropdownPrimitive.Trigger
export const DropdownMenuSeparator = (
  props: DropdownPrimitive.DropdownMenuSeparatorProps
): React.JSX.Element => <DropdownPrimitive.Separator className="my-1 h-px bg-border" {...props} />

export function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: DropdownPrimitive.DropdownMenuContentProps): React.JSX.Element {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'animate-pop z-50 min-w-40 rounded-lg border bg-elevated p-1 shadow-overlay',
          className
        )}
        {...props}
      />
    </DropdownPrimitive.Portal>
  )
}

export function DropdownMenuItem({
  className,
  ...props
}: DropdownPrimitive.DropdownMenuItemProps): React.JSX.Element {
  return (
    <DropdownPrimitive.Item
      className={cn(
        'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink outline-none select-none',
        'data-[highlighted]:bg-panel-2 data-[highlighted]:text-ink-strong data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className
      )}
      {...props}
    />
  )
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: DropdownPrimitive.DropdownMenuCheckboxItemProps): React.JSX.Element {
  return (
    <DropdownPrimitive.CheckboxItem
      className={cn(
        'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink outline-none select-none',
        'data-[highlighted]:bg-panel-2 data-[highlighted]:text-ink-strong data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className
      )}
      {...props}
    >
      <span className="flex size-3.5 items-center justify-center text-ink-strong">
        <DropdownPrimitive.ItemIndicator>
          <Check className="size-3.5" aria-hidden />
        </DropdownPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownPrimitive.CheckboxItem>
  )
}
