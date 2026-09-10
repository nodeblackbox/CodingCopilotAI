import React from 'react'
import { cn } from '@renderer/lib/utils'

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        'w-full rounded-lg border border-white/[0.08] bg-[#0a0c11] px-3 py-2 text-[13px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-teal-400/50',
        className
      )}
      {...props}
    />
  )
}
