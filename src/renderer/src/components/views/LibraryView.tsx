import { useState } from 'react'
import { Search } from 'lucide-react'
import { Input } from '@renderer/components/ui/Input'
import { Tag } from '@renderer/components/ui/Tag'
import { QUESTIONS, LIBRARY_STATUS_LABEL } from '@renderer/data/questions'
import { useAppStore } from '@renderer/state/store'

const DIFF_TAG_CLASS: Record<string, string> = {
  Easy: 'bg-emerald-400/10 text-emerald-300 ring-1 ring-emerald-400/25',
  Medium: 'bg-amber-400/10 text-amber-300 ring-1 ring-amber-400/25',
  Hard: 'bg-rose-400/10 text-rose-300 ring-1 ring-rose-400/25'
}

const FILTERS = ['All', 'Easy', 'Medium', 'Hard'] as const

export function LibraryView() {
  const openQuestion = useAppStore((s) => s.openQuestion)
  const newPlayground = useAppStore((s) => s.newPlayground)
  const startScratch = useAppStore((s) => s.startScratch)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('All')

  const rows = QUESTIONS.filter(
    (q) =>
      (q.title.toLowerCase().includes(query.toLowerCase()) ||
        q.topics.some((t) => t.toLowerCase().includes(query.toLowerCase()))) &&
      (filter === 'All' || q.difficulty === filter)
  )

  return (
    <div className="flex-1 overflow-y-auto px-10 py-9">
      <div className="mb-1 flex items-center gap-3">
        <h1 className="text-[22px] font-semibold tracking-tight">Question library</h1>
        <span className="text-[12px] text-zinc-600">{QUESTIONS.length} questions</span>
        <div className="flex-1" />
        <button
          data-testid="free-coding"
          onClick={startScratch}
          className="rounded-md border border-white/[0.1] px-3 py-1.5 text-[12.5px] text-zinc-300 hover:border-teal-400/30 hover:text-teal-300"
        >
          Free coding (no question)
        </button>
      </div>
      <p className="mb-5 text-[13px] text-zinc-500">
        Open a question in the workspace, or start a fresh saved attempt with “Practice”.
      </p>

      <div className="mb-5 flex items-center gap-2">
        <div className="relative max-w-xs flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
          <Input
            placeholder="Search by title or topic…"
            className="pl-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-md px-2.5 py-1 text-[12px] ${
              f === filter ? 'bg-teal-400/10 text-teal-300 ring-1 ring-teal-400/25' : 'text-zinc-500 hover:bg-white/5'
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-white/[0.06]">
        <div className="grid grid-cols-[1fr_100px_220px_130px_150px] gap-2 border-b border-white/[0.06] px-4 py-2.5 text-[11px] text-zinc-500">
          <span>Title</span>
          <span>Difficulty</span>
          <span>Topics</span>
          <span>Status</span>
          <span />
        </div>
        {rows.map((q, i) => (
          <div
            key={q.id}
            className={`grid grid-cols-[1fr_100px_220px_130px_150px] items-center gap-2 px-4 py-3 text-[13px] hover:bg-white/[0.02] ${
              i !== 0 ? 'border-t border-white/[0.05]' : ''
            }`}
          >
            <span className="truncate pr-2 text-zinc-200">
              <span className="mr-2 text-zinc-600">{q.index}.</span>
              {q.title}
            </span>
            <Tag className={DIFF_TAG_CLASS[q.difficulty]}>{q.difficulty}</Tag>
            <span className="truncate text-[12px] text-zinc-500">{q.topics.join(', ')}</span>
            <span className="truncate text-[12px] text-zinc-500">{LIBRARY_STATUS_LABEL[q.status]}</span>
            <div className="flex justify-end gap-1.5">
              <button
                onClick={() => openQuestion(q.id)}
                className="rounded-md border border-white/[0.08] px-2.5 py-1 text-[11.5px] text-zinc-300 hover:bg-white/5"
              >
                Open
              </button>
              <button
                onClick={() => void newPlayground(q.id)}
                className="rounded-md bg-teal-400/10 px-2.5 py-1 text-[11.5px] text-teal-300 ring-1 ring-teal-400/25 hover:bg-teal-400/20"
              >
                Practice
              </button>
            </div>
          </div>
        ))}
        {rows.length === 0 && (
          <div className="px-4 py-6 text-center text-[12.5px] text-zinc-500">No questions match.</div>
        )}
      </div>
    </div>
  )
}
