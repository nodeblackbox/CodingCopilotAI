import { useEffect, useRef, useState } from 'react'
import { Bot, Mic, MicOff, Send, Loader2, Square, Volume2, Headphones, HeadphoneOff } from 'lucide-react'
import { Textarea } from '@renderer/components/ui/Textarea'
import { Tag } from '@renderer/components/ui/Tag'
import { CHIP_DEFS } from '@renderer/data/chips'
import { useAppStore } from '@renderer/state/store'
import { HELP_STYLES } from '@shared/types'
import type { ChatMessage } from '@shared/types'

const ENGINE_LABEL: Record<string, string> = { edge: 'Ava (Edge)', kokoro: 'Kokoro', webspeech: 'OS voice' }
const ENGINE_ORDER = ['edge', 'kokoro'] as const

function Pill({ on, onClick, children, title, testId }: { on: boolean; onClick: () => void; children: React.ReactNode; title?: string; testId?: string }) {
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      title={title}
      className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
        on ? 'border-teal-400/40 bg-teal-400/10 text-teal-300' : 'border-white/[0.08] text-zinc-500 hover:bg-white/5 hover:text-zinc-300'
      }`}
    >
      {children}
    </button>
  )
}

export function CopilotPanel({ width }: { width: number }) {
  const rightMode = useAppStore((s) => s.rightMode)
  const setRightMode = useAppStore((s) => s.setRightMode)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const cursor = useAppStore((s) => s.editorState.cursor)
  const selectionRange = useAppStore((s) => s.editorState.selectionRange)
  const usage = useAppStore((s) => s.usage)
  const pausedReason = useAppStore((s) => s.pausedReason)
  const clearPaused = useAppStore((s) => s.clearPaused)

  const nextEngine = ENGINE_ORDER[(ENGINE_ORDER.indexOf(settings.ttsEngine as (typeof ENGINE_ORDER)[number]) + 1) % ENGINE_ORDER.length]
  const modelShort = settings.chatModel.includes('haiku') ? 'Haiku' : settings.chatModel.includes('sonnet') ? 'Sonnet' : settings.chatModel
  const overBudget = usage && settings.dailyBudgetUsd > 0 && usage.todayCostUsd >= settings.dailyBudgetUsd

  return (
    <div style={{ width }} className="flex flex-none flex-col border-l border-white/[0.06] bg-[#0d0f15]/40">
      <div className="flex-none border-b border-white/[0.06] p-3.5">
        <div className="mb-3 flex items-center gap-2">
          <Bot size={15} className="text-teal-400" />
          <span className="text-[13.5px] font-medium">AI Copilot</span>
          <span
            data-testid="caret-readout"
            className={`ml-auto font-mono text-[10.5px] ${selectionRange ? 'text-teal-300' : 'text-zinc-600'}`}
            title={selectionRange ? 'These highlighted lines go with your next message' : 'The copilot sees your caret position with every message'}
          >
            {selectionRange
              ? selectionRange.startLine === selectionRange.endLine
                ? `Sel L${selectionRange.startLine}`
                : `Sel L${selectionRange.startLine}–${selectionRange.endLine}`
              : `Ln ${cursor.line}, Col ${cursor.column}`}
          </span>
        </div>
        <div className="mb-2 flex items-center gap-2">
          <button
            data-testid="ai-toggle"
            onClick={() => updateSettings({ aiEnabled: !settings.aiEnabled })}
            title={settings.aiEnabled ? 'Every model call is allowed. Click to block all of them.' : 'All model calls are blocked. Click to allow.'}
            className={`rounded-md border px-2 py-0.5 text-[11px] font-medium ${
              settings.aiEnabled ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300' : 'border-rose-400/50 bg-rose-500/15 text-rose-200'
            }`}
          >
            {settings.aiEnabled ? 'AI on' : 'AI OFF'}
          </button>
          <span
            data-testid="spend-meter"
            className={`font-mono text-[10.5px] ${overBudget ? 'text-rose-300' : 'text-zinc-500'}`}
            title={
              usage
                ? `Today: ${usage.todayCalls} calls. This session: ${usage.calls} calls, ${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out tokens. Budget $${settings.dailyBudgetUsd.toFixed(2)}/day. Estimated from list prices; usage.jsonl has every call.`
                : 'No calls yet this session'
            }
          >
            {usage ? `today ≈ $${usage.todayCostUsd.toFixed(3)} / $${settings.dailyBudgetUsd.toFixed(2)} · ${modelShort}` : `${modelShort} · $0.000`}
          </span>
        </div>
        {pausedReason && (
          <div className="mb-2 flex items-start gap-2 rounded-lg border border-rose-400/40 bg-rose-500/10 px-2.5 py-2 text-[11.5px] text-rose-100">
            <span className="flex-1">{pausedReason}</span>
            <button onClick={clearPaused} className="text-rose-300 hover:text-white" title="Dismiss">
              ✕
            </button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="inline-flex rounded-lg border border-white/[0.08] p-0.5">
            {(['ask', 'agent'] as const).map((id) => (
              <button
                key={id}
                data-testid={`mode-${id}`}
                onClick={() => setRightMode(id)}
                className={`rounded-md px-3 py-1 text-[12.5px] capitalize transition-colors ${
                  rightMode === id ? 'bg-teal-400 text-[#0a0c11]' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {id}
              </button>
            ))}
          </div>
          <Pill
            on={settings.autoApplyEdits}
            onClick={() => updateSettings({ autoApplyEdits: !settings.autoApplyEdits })}
            title={
              settings.autoApplyEdits
                ? 'Edits you ask for go straight into the editor (Undo / Ctrl+Z to revert). Click to review rewrites as a diff first.'
                : 'Whole-file rewrites wait in a diff for Accept / Reject. Click to apply them straight away.'
            }
            testId="pill-auto-apply"
          >
            Auto-apply
          </Pill>
          <Pill on={settings.inlineCompletions} onClick={() => updateSettings({ inlineCompletions: !settings.inlineCompletions })} title="Grey inline code suggestions in the editor (Tab accepts)" testId="pill-ghost">
            Ghost text
          </Pill>
          <Pill
            on={true}
            onClick={() => updateSettings({ ttsEngine: nextEngine, voiceName: nextEngine === 'edge' ? 'en-US-AvaNeural' : 'af_heart' })}
            title="Click to switch the speaking voice engine"
          >
            🔊 {ENGINE_LABEL[settings.ttsEngine] ?? settings.ttsEngine}
          </Pill>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[10.5px] uppercase tracking-wide text-zinc-600">Help</span>
          <div className="inline-flex rounded-lg border border-white/[0.08] p-0.5" data-testid="help-style">
            {HELP_STYLES.map((h) => (
              <button
                key={h.id}
                data-testid={`help-style-${h.id}`}
                title={h.hint}
                onClick={() => updateSettings({ helpStyle: h.id, guidedVoice: h.id === 'guided' })}
                className={`rounded-md px-2 py-0.5 text-[11.5px] transition-colors ${
                  settings.helpStyle === h.id ? 'bg-teal-400/20 text-teal-200' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {h.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {rightMode === 'agent' ? <AgentMode /> : <AskMode />}
    </div>
  )
}

function AgentMode() {
  const activeChip = useAppStore((s) => s.activeChip)
  const chipLoading = useAppStore((s) => s.chipLoading)
  const chipResult = useAppStore((s) => s.chipResult)
  const diffVisible = useAppStore((s) => s.diffVisible)
  const selectChip = useAppStore((s) => s.selectChip)

  return (
    <div className="flex-1 overflow-y-auto p-3.5">
      <div className="flex flex-wrap gap-1.5">
        {CHIP_DEFS.map((chip) => {
          const Icon = chip.icon
          const on = activeChip === chip.id
          return (
            <button
              key={chip.id}
              onClick={() => selectChip(chip.id)}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] transition-colors ${
                on
                  ? 'bg-teal-400 text-[#0a0c11]'
                  : 'border border-white/[0.08] text-zinc-400 hover:border-teal-400/25 hover:text-teal-300'
              }`}
            >
              <Icon size={12} /> {chip.label}
            </button>
          )
        })}
      </div>

      {(chipLoading || chipResult) && (
        <div className="mt-3 rounded-xl border border-white/[0.06] bg-[#0a0c11] p-3.5">
          {chipLoading ? (
            <div className="flex items-center gap-2 text-[12.5px] text-zinc-400">
              <Loader2 size={13} className="animate-spin text-teal-400" /> Thinking…
            </div>
          ) : (
            chipResult && (
              <>
                <div className="text-[13.5px] font-medium text-zinc-100">{chipResult.title}</div>
                <p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-relaxed text-zinc-400">
                  {chipResult.summary}
                </p>
                {diffVisible && <div className="mt-2.5 text-[11.5px] text-teal-400">↑ See the proposed diff in the editor</div>}
              </>
            )
          )}
        </div>
      )}
    </div>
  )
}

/** A reply the user talked over shows what they heard, then the unheard rest dimmed. */
function MessageText({ m }: { m: ChatMessage }) {
  if (m.role !== 'assistant' || m.heard === undefined) return <>{m.text}</>
  // `heard` is the spoken (markdown-free) text, so find where its last words sit in the displayed text.
  const tail = m.heard.replace(/…$/, '').trim().split(/\s+/).slice(-3).join(' ')
  const at = tail ? m.text.indexOf(tail) : -1
  const cut = at >= 0 ? at + tail.length : Math.min(m.text.length, m.heard.length)
  return (
    <>
      <span>{m.text.slice(0, cut)}</span>
      <span className="mx-1 text-[10.5px] text-rose-300/80" title="You cut in here — the copilot knows you didn't hear the rest">
        ✂ cut off
      </span>
      <span className="text-zinc-500">{m.text.slice(cut)}</span>
    </>
  )
}

function AskMode() {
  const settings = useAppStore((s) => s.settings)
  const messages = useAppStore((s) => s.messages)
  const chatSending = useAppStore((s) => s.chatSending)
  const sendMessage = useAppStore((s) => s.sendMessage)
  const cancelReply = useAppStore((s) => s.cancelReply)
  const voice = useAppStore((s) => s.voice)
  const toggleMic = useAppStore((s) => s.toggleMic)
  const toggleMute = useAppStore((s) => s.toggleMute)
  const toggleDeafen = useAppStore((s) => s.toggleDeafen)
  const stopSpeaking = useAppStore((s) => s.stopSpeaking)

  const notes = useAppStore((s) => s.notes)
  const removeNote = useAppStore((s) => s.removeNote)
  const solutionUnlocked = useAppStore((s) => s.solutionUnlocked)
  const lastAiEdit = useAppStore((s) => s.lastAiEdit)
  // Only while the file is untouched since that edit: undoing after you kept typing would eat your work.
  const canUndo = useAppStore((s) => s.lastAiEdit !== null && s.lastAiEdit.after === s.code)
  const undoAiEdit = useAppStore((s) => s.undoAiEdit)
  const styleInfo = HELP_STYLES.find((h) => h.id === settings.helpStyle)

  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, voice.partial])

  const submit = () => {
    if (!input.trim()) return
    const text = input
    setInput('')
    void sendMessage(text)
  }

  const micLabel = voice.connecting
    ? 'Starting voice…'
    : voice.micOn
      ? voice.stt === 'loading'
        ? 'Listening (speech model still loading)'
        : 'Listening'
      : 'Voice off'

  return (
    <div className="flex flex-1 flex-col overflow-hidden p-3.5">
      <div className={`flex flex-wrap items-center gap-1.5 ${notes.length || solutionUnlocked ? 'mb-2' : ''}`}>
        {solutionUnlocked && (settings.helpStyle === 'coach' || settings.helpStyle === 'guided') && (
          <Tag className="bg-amber-400/10 text-amber-200 ring-1 ring-amber-400/25" title={`You asked for the answer, so ${styleInfo?.label} mode may show the solution now. Resets on the next problem.`}>
            Answer unlocked
          </Tag>
        )}
        {notes.map((n, i) => (
          <span
            key={`${i}-${n}`}
            data-testid="session-note"
            title="Session note — the copilot follows this for the rest of the problem. Click × to forget it."
            className="inline-flex max-w-full items-center gap-1 rounded-md border border-white/[0.08] px-1.5 py-0.5 text-[10.5px] text-zinc-400"
          >
            <span className="truncate">📌 {n}</span>
            <button onClick={() => removeNote(i)} className="text-zinc-600 hover:text-zinc-200" aria-label="Forget this note">
              ×
            </button>
          </span>
        ))}
      </div>
      <div ref={scrollRef} className="flex-1 space-y-2.5 overflow-y-auto">
        {messages.map((m, i) => {
          const streaming = chatSending && i === messages.length - 1 && m.role === 'assistant'
          return (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[90%] whitespace-pre-wrap rounded-xl px-3 py-2 text-[13px] leading-relaxed ${
                  m.role === 'user' ? 'bg-teal-400/15 text-teal-100' : 'bg-white/[0.05] text-zinc-200'
                }`}
              >
                <MessageText m={m} />
                {streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-teal-400/70 align-middle" />}
              </div>
            </div>
          )
        })}
        {voice.partial && (
          <div className="flex justify-end">
            <div className="max-w-[90%] rounded-xl border border-dashed border-teal-400/30 px-3 py-2 text-[13px] italic text-teal-200/70">
              {voice.partial}
            </div>
          </div>
        )}
      </div>

      <div className="mt-2.5 flex-none space-y-2 border-t border-white/[0.06] pt-2.5">
        <div className="flex items-center gap-2">
          <button
            data-testid="mic-toggle"
            onClick={() => void toggleMic()}
            disabled={voice.connecting}
            title={micLabel}
            className={`flex h-7 w-7 items-center justify-center rounded-lg border ${
              voice.micOn
                ? voice.userSpeaking
                  ? 'border-teal-300 bg-teal-400/30 text-teal-100'
                  : 'border-teal-400/40 bg-teal-400/10 text-teal-300'
                : 'border-white/[0.08] text-zinc-400 hover:bg-white/5'
            }`}
          >
            {voice.connecting ? <Loader2 size={13} className="animate-spin" /> : voice.micOn ? <Mic size={13} /> : <MicOff size={13} />}
          </button>
          {canUndo && lastAiEdit && (
            <button
              data-testid="undo-ai-edit"
              onClick={undoAiEdit}
              title={`Put the file back the way it was before the copilot's last ${lastAiEdit.label}`}
              className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-[11.5px] text-amber-200 hover:bg-amber-400/20"
            >
              Undo AI edit
            </button>
          )}
          <span className="flex-1 truncate text-[11px] text-zinc-500">{micLabel}</span>
          {voice.micOn && (
            <span className="flex h-3 w-14 flex-none items-end gap-px" title="Mic level">
              {[0.02, 0.05, 0.1, 0.18, 0.3].map((t, i) => (
                <span
                  key={i}
                  className={`w-2 rounded-sm transition-colors ${voice.level >= t ? 'bg-teal-400' : 'bg-white/10'}`}
                  style={{ height: `${40 + i * 15}%` }}
                />
              ))}
            </span>
          )}
          {(voice.agentSpeaking || chatSending) && (
            <button
              data-testid="stop-reply"
              onClick={() => (voice.agentSpeaking ? stopSpeaking() : cancelReply())}
              className="inline-flex items-center gap-1 rounded-lg border border-rose-400/30 bg-rose-400/10 px-2 py-1 text-[11.5px] text-rose-200 hover:bg-rose-400/20"
            >
              {voice.agentSpeaking ? <Volume2 size={11} className="animate-pulse" /> : <Square size={10} />}
              {voice.agentSpeaking ? (voice.ducked ? 'Ducked · talk to cut in' : 'Speaking · stop') : 'Stop'}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            data-testid="mute-toggle"
            onClick={toggleMute}
            disabled={voice.deafened}
            title={voice.deafened ? 'Undeafen to change mute' : voice.micMuted ? 'Unmute your microphone' : 'Mute your microphone'}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              voice.micMuted
                ? 'border-rose-400/50 bg-rose-500/15 text-rose-200'
                : 'border-white/[0.08] text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
            }`}
          >
            {voice.micMuted ? <MicOff size={12} /> : <Mic size={12} />}
            {voice.micMuted ? 'Muted' : 'Mute'}
          </button>
          <button
            data-testid="deafen-toggle"
            onClick={toggleDeafen}
            title={voice.deafened ? 'Undeafen' : 'Deafen — mutes your mic and stops the assistant\'s voice'}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
              voice.deafened
                ? 'border-sky-400/50 bg-sky-500/15 text-sky-300'
                : 'border-white/[0.08] text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
            }`}
          >
            {voice.deafened ? <HeadphoneOff size={12} /> : <Headphones size={12} />}
            {voice.deafened ? 'Deafened' : 'Deafen'}
          </button>
        </div>
        {voice.lastError && <div className="text-[11px] text-rose-300">{voice.lastError}</div>}
        <Textarea
          rows={2}
          data-testid="chat-input"
          placeholder="Ask about this code, or talk through your approach…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="flex items-center gap-2">
          <span className="flex-1 text-[10.5px] text-zinc-600">Enter for new line · Ctrl/Cmd+Enter to send</span>
          <button
            data-testid="chat-send"
            onClick={submit}
            disabled={!input.trim()}
            className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-teal-400 text-[#0a0c11] disabled:opacity-30"
          >
            <Send size={12} />
          </button>
        </div>
      </div>
    </div>
  )
}
