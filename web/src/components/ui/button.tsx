import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'
import { cn } from '../../lib/utils'

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center rounded-[var(--radius)] border font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)] disabled:pointer-events-none disabled:cursor-not-allowed',
  {
    variants: {
      variant: {
        primary: 'border-[var(--accent)] bg-[var(--accent)] px-4 py-2.5 text-[13px] text-[var(--accent-fg)] hover:brightness-95 disabled:border-[var(--rule)] disabled:bg-transparent disabled:text-[var(--faint)]',
        ghost: 'border-[var(--rule)] bg-transparent px-2.5 font-mono text-[11px] uppercase tracking-[.08em] text-[var(--accent)] hover:border-[var(--accent)]',
        secondary: 'border-[var(--input-border)] bg-transparent px-3 py-2 font-mono text-[11px] uppercase tracking-[.08em] text-[var(--dim)] hover:border-[var(--ink)] hover:text-[var(--ink)] disabled:text-[var(--faint)]',
      },
    },
    defaultVariants: { variant: 'primary' },
  },
)

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant }), className)} {...props} />
}
