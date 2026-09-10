import React from 'react'
import { cn } from '@renderer/lib/utils'

export function Tag({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium', className)}>
      {children}
    </span>
  )
}
