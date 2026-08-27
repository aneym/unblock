import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'
import { cn } from '../../lib/utils'

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center rounded-[var(--radius)] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)] disabled:pointer-events-none disabled:cursor-not-allowed',
  {
    variants: {
      variant: {
        primary: 'h-10 bg-[var(--accent)] px-4 text-[14px] text-[var(--accent-fg)] hover:brightness-95 disabled:bg-[var(--surface2)] disabled:text-[var(--faint)]',
        ghost: 'h-9 px-2.5 text-[13.5px] text-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:text-[var(--faint)]',
        secondary: 'h-10 border border-[var(--input-border)] bg-transparent px-3.5 text-[13.5px] text-[var(--dim)] hover:border-[var(--ink)] hover:text-[var(--ink)] disabled:text-[var(--faint)]',
      },
    },
    defaultVariants: { variant: 'primary' },
  },
)

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant }), className)} {...props} />
}
