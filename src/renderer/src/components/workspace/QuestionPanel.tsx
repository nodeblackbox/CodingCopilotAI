import { Tag } from '@renderer/components/ui/Tag'
import { useAppStore } from '@renderer/state/store'
import { CHIP_DEFS } from '@renderer/data/chips'

const DIFF_TAG_CLASS: Record<string, string> = {
  Easy: 'bg-emerald-400/10 text-emerald-300 ring-1 ring-emerald-400/25',
  Medium: 'bg-amber-400/10 text-amber-300 ring-1 ring-amber-400/25',
  Hard: 'bg-rose-400/10 text-rose-300 ring-1 ring-rose-400/25'
}

const QUICK_CHIP_LABELS = ['Explain problem', 'Get hints', 'Idea map', 'Related problems']

export function QuestionPanel({ width }: { width: number }) {
  const question = useAppStore((s) => s.question)
  const setRightMode = useAppStore((s) => s.setRightMode)
  const selectChip = useAppStore((s) => s.selectChip)

  return (
    <div
      style={{ width }}
      className="flex-none overflow-y-auto border-r border-white/[0.06] bg-[#0d0f15]/40 px-6 py-6"
    >
      <div className="mb-3 flex gap-1.5">
        <Tag className={DIFF_TAG_CLASS[question.difficulty]}>{question.difficulty}</Tag>
        {question.topics.map((t) => (
          <Tag key={t} className="bg-white/[0.06] text-zinc-400">
            {t}
          </Tag>
        ))}
      </div>
      <h2 className="mb-3 text-[19px] font-semibold tracking-tight">
        {question.index}. {question.title}
      </h2>
      <p className="text-[13.5px] leading-relaxed text-zinc-400">{question.prompt}</p>

      {question.examples.map((ex) => (
        <div
          key={ex.heading}
          className="mt-3.5 rounded-lg border border-white/[0.06] bg-[#0a0c11] p-3 font-mono text-[12px] leading-relaxed"
        >
          <div className="mb-1 text-teal-400/80">{ex.heading}</div>
          {ex.lines.map((l, i) => (
            <div key={i} className={i === ex.lines.length - 1 && ex.lines.length > 2 ? 'text-zinc-600' : 'text-zinc-400'}>
              {l}
            </div>
          ))}
        </div>
      ))}

      <h3 className="mb-2 mt-5 text-[12px] font-medium text-zinc-300">Constraints</h3>
      <ul className="space-y-1 text-[12.5px] text-zinc-500">
        {question.constraints.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>

      <div className="mt-5 flex flex-wrap gap-1.5">
        {QUICK_CHIP_LABELS.map((label) => {
          const chip = CHIP_DEFS.find((c) => c.label === label)!
          return (
            <button
              key={label}
              onClick={() => {
                setRightMode('agent')
                selectChip(chip.id)
              }}
              className="rounded-md border border-white/[0.08] px-2.5 py-1.5 text-[12px] text-zinc-400 hover:border-teal-400/25 hover:text-teal-300"
            >
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
