import * as React from 'react'
import { cn } from '../../lib/utils'

export function Card({ className, ...props }: React.ComponentProps<'article'>) {
  return <article className={cn('rounded-[var(--radius)] border border-[var(--rule)] bg-[var(--surface)]', className)} {...props} />
}
