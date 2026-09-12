import { Volume2, Square, Loader2, FileCode2, RotateCcw } from 'lucide-react'
import { Tag } from '@renderer/components/ui/Tag'
import { Textarea } from '@renderer/components/ui/Textarea'
import { useAppStore } from '@renderer/state/store'
import { CHIP_DEFS } from '@renderer/data/chips'
import { isScratch, starterFor, templateFor } from '@renderer/data/questions'

const DIFF_TAG_CLASS: Record<string, string> = {
  Easy: 'bg-emerald-400/10 text-emerald-300 ring-1 ring-emerald-400/25',
  Medium: 'bg-amber-400/10 text-amber-300 ring-1 ring-amber-400/25',
  Hard: 'bg-rose-400/10 text-rose-300 ring-1 ring-rose-400/25'
}

const QUICK_CHIP_LABELS = ['Explain problem', 'Get hints', 'Idea map', 'Related problems']

export function QuestionPanel({ width }: { width: number }) {
  const question = useAppStore((s) => s.question)
  const language = useAppStore((s) => s.language)
  const code = useAppStore((s) => s.code)
  const setRightMode = useAppStore((s) => s.setRightMode)
  const selectChip = useAppStore((s) => s.selectChip)
  const readQuestionAloud = useAppStore((s) => s.readQuestionAloud)
  const stopSpeaking = useAppStore((s) => s.stopSpeaking)
  const agentSpeaking = useAppStore((s) => s.voice.agentSpeaking)
  const connecting = useAppStore((s) => s.voice.connecting)
  const scratchNotes = useAppStore((s) => s.scratchNotes)
  const setScratchNotes = useAppStore((s) => s.setScratchNotes)
  const resetCode = useAppStore((s) => s.resetCode)
  const selection = useAppStore((s) => s.editorState.selectionRange)

  const scratch = isScratch(question)
  const template = templateFor(question, language)
  const starter = starterFor(question, language)
  const hasTemplate = template !== starter
  const onTemplate = code === template
  const onStarter = code === starter

  return (
    <div style={{ width }} className="flex-none overflow-y-auto border-r border-white/[0.06] bg-[#0d0f15]/40 px-6 py-6">
      {!scratch && (
        <div className="mb-3 flex gap-1.5">
          <Tag className={DIFF_TAG_CLASS[question.difficulty]}>{question.difficulty}</Tag>
          {question.topics.map((t) => (
            <Tag key={t} className="bg-white/[0.06] text-zinc-400">
              {t}
            </Tag>
          ))}
        </div>
      )}
      <div className="mb-3 flex items-start gap-2">
        <h2 className="flex-1 text-[19px] font-semibold tracking-tight">{scratch ? 'Free coding' : `${question.index}. ${question.title}`}</h2>
        {!scratch && (
          <button
            data-testid="read-aloud"
            onClick={() => (agentSpeaking ? stopSpeaking() : void readQuestionAloud())}
            disabled={connecting}
            title={agentSpeaking ? 'Stop reading' : 'Read the question aloud (no model call)'}
            className={`mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-lg border ${
              agentSpeaking ? 'border-rose-400/40 bg-rose-400/10 text-rose-200' : 'border-white/[0.08] text-zinc-400 hover:bg-white/5 hover:text-teal-300'
            }`}
          >
            {connecting ? <Loader2 size={13} className="animate-spin" /> : agentSpeaking ? <Square size={11} /> : <Volume2 size={13} />}
          </button>
        )}
      </div>

      {scratch ? (
        <>
          <p className="text-[13.5px] leading-relaxed text-zinc-400">
            No problem loaded. Whatever you write here goes to the copilot with every turn, so it knows what you&apos;re building.
          </p>
          <Textarea
            data-testid="scratch-notes"
            rows={6}
            value={scratchNotes}
            onChange={(e) => setScratchNotes(e.target.value)}
            placeholder="e.g. Parsing a CSV of trades and grouping by symbol; want it in pandas but the merge is slow…"
            className="mt-3 text-[13px]"
          />
        </>
      ) : (
        <>
          <p className="text-[13.5px] leading-relaxed text-zinc-400">{question.prompt}</p>

          {question.examples.map((ex) => (
            <div key={ex.heading} className="mt-3.5 rounded-lg border border-white/[0.06] bg-[#0a0c11] p-3 font-mono text-[12px] leading-relaxed">
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

          <h3 className="mb-2 mt-5 text-[12px] font-medium text-zinc-300">Editor</h3>
          <div className="flex flex-wrap gap-1.5">
            <button
              data-testid="reset-template"
              onClick={() => resetCode('template')}
              title="Signature only — no attempt in the body"
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] ${
                onTemplate ? 'border-teal-400/40 bg-teal-400/10 text-teal-300' : 'border-white/[0.08] text-zinc-400 hover:border-teal-400/25 hover:text-teal-300'
              }`}
            >
              <FileCode2 size={12} /> Blank template
            </button>
            {hasTemplate && (
              <button
                onClick={() => resetCode('starter')}
                title="The starter attempt (e.g. brute force) to optimise from"
                className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] ${
                  onStarter ? 'border-teal-400/40 bg-teal-400/10 text-teal-300' : 'border-white/[0.08] text-zinc-400 hover:border-teal-400/25 hover:text-teal-300'
                }`}
              >
                <RotateCcw size={12} /> Starter attempt
              </button>
            )}
          </div>
        </>
      )}

      <div className="mt-5 flex flex-wrap gap-1.5">
        {QUICK_CHIP_LABELS.map((label) => {
          const chip = CHIP_DEFS.find((c) => c.label === label)!
          const scoped = selection && (label === 'Explain problem' || label === 'Get hints')
          return (
            <button
              key={label}
              onClick={() => {
                setRightMode('agent')
                selectChip(chip.id)
              }}
              title={scoped ? `Applies to your highlighted lines ${selection.startLine}–${selection.endLine}` : undefined}
              className="rounded-md border border-white/[0.08] px-2.5 py-1.5 text-[12px] text-zinc-400 hover:border-teal-400/25 hover:text-teal-300"
            >
              {label === 'Explain problem' && selection ? `Explain lines ${selection.startLine}–${selection.endLine}` : label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
