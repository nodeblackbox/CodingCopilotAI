import { useEffect } from 'react'
import { FileCode2, Plus, Shuffle } from 'lucide-react'
import { Button } from '@renderer/components/ui/Button'
import { useAppStore } from '@renderer/state/store'
import { questionById } from '@renderer/data/questions'

function timeAgo(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function PlaygroundsView() {
  const playgrounds = useAppStore((s) => s.playgrounds)
  const currentPlaygroundId = useAppStore((s) => s.currentPlaygroundId)
  const loadPlaygrounds = useAppStore((s) => s.loadPlaygrounds)
  const newPlayground = useAppStore((s) => s.newPlayground)
  const openPlayground = useAppStore((s) => s.openPlayground)
  const setView = useAppStore((s) => s.setView)

  useEffect(() => {
    void loadPlaygrounds()
  }, [loadPlaygrounds])

  return (
    <div className="flex-1 overflow-y-auto px-10 py-9">
      <div className="mb-1 flex items-center gap-3">
        <h1 className="text-[22px] font-semibold tracking-tight">Playgrounds</h1>
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => setView('library')}>
          Pick a question
        </Button>
        <Button size="sm" data-testid="new-playground" onClick={() => void newPlayground()}>
          <Shuffle size={13} /> New playground
        </Button>
      </div>
      <p className="mb-6 text-[13px] text-zinc-500">
        Every attempt is saved on its own. “New playground” hands you a problem you haven’t started yet.
      </p>

      {playgrounds.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/[0.1] p-8 text-center text-[13px] text-zinc-500">
          <Plus size={16} className="mx-auto mb-2 text-zinc-600" />
          No playgrounds yet. Hit “New playground” for a random problem, or pick one from the library.
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-3.5">
          {playgrounds.map((p) => {
            const q = questionById(p.questionId)
            const active = p.id === currentPlaygroundId
            return (
              <div
                key={p.id}
                onClick={() => void openPlayground(p.id)}
                className={`cursor-pointer rounded-xl border bg-[#0d0f15] p-4 transition-colors hover:border-teal-400/25 hover:bg-white/[0.02] ${
                  active ? 'border-teal-400/40' : 'border-white/[0.06]'
                }`}
              >
                <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                  <FileCode2 size={12} /> {q ? `${q.difficulty} · ${q.category}` : 'No question linked'}
                </div>
                <div className="mt-2 text-[14.5px] font-medium text-zinc-100">{q?.title ?? p.title}</div>
                <div className="mt-2.5 text-[11.5px] text-zinc-600">
                  {p.files[0]?.language ?? 'python'} · {p.messages.filter((m) => m.role === 'user').length} messages · edited{' '}
                  {timeAgo(p.updatedAt)}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
