import * as React from 'react'
import { cn } from '../../lib/utils'

export function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'min-h-24 w-full resize-y rounded-[var(--radius)] border border-[var(--input-border)] bg-[var(--surface)] px-3.5 py-2.5 text-[16px] leading-relaxed text-[var(--ink)] outline-none placeholder:text-[var(--dim)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-1 focus:ring-offset-[var(--bg)] disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}
