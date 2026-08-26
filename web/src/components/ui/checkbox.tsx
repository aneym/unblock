import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { cn } from '../../lib/utils'

export function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[var(--radius)] border border-[var(--input-border)] bg-[var(--bg)] text-[var(--accent-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] data-[state=checked]:border-[var(--accent)] data-[state=checked]:bg-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="text-[11px] font-bold leading-none">✓</CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}
