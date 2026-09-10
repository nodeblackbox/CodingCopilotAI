import { useEffect, useRef, useState } from 'react'
import { Bot, Mic, MicOff, Send, Loader2, Square, Volume2 } from 'lucide-react'
import { Textarea } from '@renderer/components/ui/Textarea'
import { Tag } from '@renderer/components/ui/Tag'
import { CHIP_DEFS } from '@renderer/data/chips'
import { useAppStore } from '@renderer/state/store'

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

  const nextEngine = ENGINE_ORDER[(ENGINE_ORDER.indexOf(settings.ttsEngine as (typeof ENGINE_ORDER)[number]) + 1) % ENGINE_ORDER.length]

  return (
    <div style={{ width }} className="flex flex-none flex-col border-l border-white/[0.06] bg-[#0d0f15]/40">
      <div className="flex-none border-b border-white/[0.06] p-3.5">
        <div className="mb-3 flex items-center gap-2">
          <Bot size={15} className="text-teal-400" />
          <span className="text-[13.5px] font-medium">AI Copilot</span>
          <span className="ml-auto font-mono text-[10.5px] text-zinc-600" title="The copilot sees your caret position with every message">
            Ln {cursor.line}, Col {cursor.column}
          </span>
        </div>
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
          <Pill on={settings.guidedVoice} onClick={() => updateSettings({ guidedVoice: !settings.guidedVoice })} title="One step at a time instead of full answers">
            Guided
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

function AskMode() {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const messages = useAppStore((s) => s.messages)
  const chatSending = useAppStore((s) => s.chatSending)
  const sendMessage = useAppStore((s) => s.sendMessage)
  const cancelReply = useAppStore((s) => s.cancelReply)
  const voice = useAppStore((s) => s.voice)
  const toggleMic = useAppStore((s) => s.toggleMic)
  const stopSpeaking = useAppStore((s) => s.stopSpeaking)

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
      {settings.guidedVoice && (
        <Tag className="mb-2 self-start bg-teal-400/10 text-teal-300 ring-1 ring-teal-400/25">
          Guided mode — I&apos;ll walk you through it step by step
        </Tag>
      )}
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
                {m.text}
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
          <button
            onClick={() => updateSettings({ guidedVoice: !settings.guidedVoice })}
            className={`rounded-lg border px-2.5 py-1.5 text-[12px] ${
              settings.guidedVoice
                ? 'border-teal-400/40 bg-teal-400/10 text-teal-300'
                : 'border-white/[0.08] text-zinc-400 hover:bg-white/5'
            }`}
          >
            Guided voice
          </button>
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
              {voice.agentSpeaking ? 'Speaking · stop' : 'Stop'}
            </button>
          )}
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
