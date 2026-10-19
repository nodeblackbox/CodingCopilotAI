import React from 'react'
import { cn } from '@renderer/lib/utils'

export function Tag({ children, className = '', title }: { children: React.ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium', className)}>
      {children}
    </span>
  )
}
