import { Terminal as TerminalIcon, Loader2, ChevronDown, ChevronUp } from 'lucide-react'
import { useAppStore } from '@renderer/state/store'

export function TerminalDrawer() {
  const terminalOpen = useAppStore((s) => s.terminalOpen)
  const setTerminalOpen = useAppStore((s) => s.setTerminalOpen)
  const running = useAppStore((s) => s.running)
  const terminalLines = useAppStore((s) => s.terminalLines)

  return (
    <div className="flex-none border-t border-white/[0.06] bg-[#0d0f15]/60">
      <button
        onClick={() => setTerminalOpen(!terminalOpen)}
        className="flex h-9 w-full items-center gap-2 px-3 text-left"
      >
        <TerminalIcon size={13} className="text-zinc-500" />
        <span className="text-[11px] text-zinc-500">Console</span>
        <div className="flex-1" />
        {running && <Loader2 size={12} className="animate-spin text-teal-400" />}
        {terminalOpen ? (
          <ChevronDown size={13} className="text-zinc-500" />
        ) : (
          <ChevronUp size={13} className="text-zinc-500" />
        )}
      </button>
      {terminalOpen && (
        <div className="h-40 overflow-y-auto px-3.5 pb-3 font-mono text-[12px] text-zinc-400">
          {terminalLines.map((l, i) => (
            <div key={i} className="whitespace-pre-wrap py-0.5">
              {l.text}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
