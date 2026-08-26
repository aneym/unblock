import * as React from 'react'
import { cn } from '../../lib/utils'

export function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'w-full rounded-[var(--radius)] border border-[var(--input-border)] bg-[var(--bg)] px-3 py-2 text-[15px] leading-6 text-[var(--ink)] outline-none placeholder:text-[var(--dim)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-1 focus:ring-offset-[var(--bg)] disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}
