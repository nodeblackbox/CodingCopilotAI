import React from 'react'
import { cn } from '@renderer/lib/utils'

type Variant = 'default' | 'outline' | 'ghost'
type Size = 'default' | 'sm'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

const VARIANT_CLASS: Record<Variant, string> = {
  default: 'bg-teal-400 text-[#0a0c11] hover:bg-teal-300',
  outline: 'border border-white/[0.1] bg-transparent text-zinc-300 hover:bg-white/5',
  ghost: 'bg-transparent text-zinc-300 hover:bg-white/5'
}

const SIZE_CLASS: Record<Size, string> = {
  default: 'h-9 px-3.5 text-[13px]',
  sm: 'h-7 px-2.5 text-[12px]'
}

export function Button({ className, variant = 'default', size = 'default', ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        className
      )}
      {...props}
    />
  )
}
