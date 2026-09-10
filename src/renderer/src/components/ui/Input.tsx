import React from 'react'
import { cn } from '@renderer/lib/utils'

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-9 w-full rounded-lg border border-white/[0.08] bg-[#12151c] px-3 text-[13px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-teal-400/50',
        className
      )}
      {...props}
    />
  )
}
