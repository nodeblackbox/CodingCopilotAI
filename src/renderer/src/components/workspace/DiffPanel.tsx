import { useMemo } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/Button'
import { Tag } from '@renderer/components/ui/Tag'
import { useAppStore } from '@renderer/state/store'
import { computeDiffLines } from '@renderer/lib/diffLines'

export function DiffPanel() {
  const code = useAppStore((s) => s.code)
  const proposedCode = useAppStore((s) => s.proposedCode)
  const diffState = useAppStore((s) => s.diffState)
  const chipResult = useAppStore((s) => s.chipResult)
  const acceptDiff = useAppStore((s) => s.acceptDiff)
  const rejectDiff = useAppStore((s) => s.rejectDiff)

  const lines = useMemo(() => computeDiffLines(code, proposedCode), [code, proposedCode])

  // Until the provider responds there is nothing to diff — show progress, not a bogus all-deletions diff.
  if (!proposedCode) {
    return (
      <div className="mx-5 mt-4 flex items-center gap-2 rounded-xl border border-white/[0.08] bg-[#0d0f15] p-3.5 text-[12px] text-zinc-400">
        <Loader2 size={13} className="animate-spin text-teal-400" />
        Generating proposed change…
      </div>
    )
  }

  return (
    <div className="mx-5 mt-4 rounded-xl border border-white/[0.08] bg-[#0d0f15] p-3.5">
      <div className="mb-2.5 text-[11.5px] text-zinc-500">Proposed change — {chipResult?.title ?? 'Copilot'}</div>
      <div className="max-h-80 overflow-y-auto">
        {lines.map((l, i) => (
          <div key={i} className="flex gap-2.5 text-[12px] leading-relaxed">
            <span
              className={`w-3 flex-none font-semibold ${
                l.type === 'add' ? 'text-teal-400' : l.type === 'del' ? 'text-rose-500/70' : 'text-zinc-700'
              }`}
            >
              {l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}
            </span>
            <span
              className={`whitespace-pre font-mono ${
                l.type === 'add'
                  ? 'text-teal-100'
                  : l.type === 'del'
                    ? 'text-zinc-600 line-through decoration-zinc-700'
                    : 'text-zinc-500'
              }`}
            >
              {l.text}
            </span>
          </div>
        ))}
      </div>
      {diffState === 'pending' && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={acceptDiff}>
            Accept
          </Button>
          <Button size="sm" variant="outline" onClick={rejectDiff}>
            Reject
          </Button>
        </div>
      )}
      {diffState === 'accepted' && (
        <Tag className="mt-3 bg-teal-400/10 text-teal-300 ring-1 ring-teal-400/25">Applied to editor</Tag>
      )}
      {diffState === 'rejected' && <Tag className="mt-3 bg-white/[0.06] text-zinc-400">Discarded</Tag>}
    </div>
  )
}
