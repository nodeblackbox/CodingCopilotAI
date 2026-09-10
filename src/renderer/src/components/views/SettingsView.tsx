import { useEffect, useState } from 'react'
import { Button } from '@renderer/components/ui/Button'
import { Input } from '@renderer/components/ui/Input'
import { useAppStore, DEFAULT_VOICE } from '@renderer/state/store'
import { listWebSpeechVoices } from '@renderer/lib/voiceClient'
import type { AiProviderId, TtsEngine } from '@shared/types'
import { ANTHROPIC_MODELS, COST_LIMITS } from '@shared/types'

const PROVIDER_LABEL: Record<AiProviderId, string> = {
  anthropic: 'Anthropic Claude',
  groq: 'Groq (gpt-oss)',
  gemini: 'Google Gemini'
}

const EDGE_VOICES = ['en-US-AvaNeural', 'en-US-AvaMultilingualNeural', 'en-US-AndrewNeural', 'en-US-EmmaNeural', 'en-GB-SoniaNeural']
const KOKORO_VOICES = ['af_heart', 'af_bella', 'am_michael', 'bf_emma']

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3">
      <div>
        <div className="text-[13.5px] font-medium text-zinc-200">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] text-zinc-500">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

const selectClass =
  'rounded-lg border border-white/[0.08] bg-[#12151c] px-3 py-1.5 text-[13px] text-zinc-200 outline-none focus:border-teal-400/50'

export function SettingsView() {
  const settings = useAppStore((s) => s.settings)
  const providerStatuses = useAppStore((s) => s.providerStatuses)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const voice = useAppStore((s) => s.voice)
  const usage = useAppStore((s) => s.usage)
  const [logPath, setLogPath] = useState<string | null>(null)
  const [webVoices, setWebVoices] = useState<string[]>([])

  useEffect(() => {
    const refresh = (): void => setWebVoices(listWebSpeechVoices().map((v) => v.name))
    refresh()
    window.speechSynthesis?.addEventListener('voiceschanged', refresh)
    return () => window.speechSynthesis?.removeEventListener('voiceschanged', refresh)
  }, [])

  const voices = settings.ttsEngine === 'edge' ? EDGE_VOICES : settings.ttsEngine === 'kokoro' ? KOKORO_VOICES : webVoices
  const sidecar = voice.sidecar

  return (
    <div className="flex-1 overflow-y-auto px-10 py-9">
      <div className="max-w-2xl">
        <h1 className="text-[22px] font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-[13px] text-zinc-500">AI provider, voice, editor, and shortcuts.</p>

        <h2 className="mb-3 mt-8 text-[13px] font-medium text-zinc-300">Spend controls</h2>
        <div className="divide-y divide-white/[0.06] rounded-xl border border-white/[0.06]">
          <Row label="AI calls" hint="Master switch. Off = chat, chips and ghost text never contact a provider.">
            <Button size="sm" variant={settings.aiEnabled ? 'default' : 'outline'} onClick={() => updateSettings({ aiEnabled: !settings.aiEnabled })}>
              {settings.aiEnabled ? 'On' : 'Off'}
            </Button>
          </Row>
          <Row label="Chat model" hint="Haiku is ~3× cheaper than Sonnet and plenty for coaching. Voice turns happen often — keep them cheap.">
            <select value={settings.chatModel} onChange={(e) => updateSettings({ chatModel: e.target.value })} className={selectClass}>
              <option value={ANTHROPIC_MODELS.haiku}>Claude Haiku 4.5 (cheap)</option>
              <option value={ANTHROPIC_MODELS.sonnet}>Claude Sonnet 5</option>
            </select>
          </Row>
          <Row
            label="Daily budget (USD)"
            hint={`Estimated from list prices. Today ≈ $${(usage?.todayCostUsd ?? 0).toFixed(3)} over ${usage?.todayCalls ?? 0} calls; this session ${usage?.calls ?? 0} calls. Every call is in usage.jsonl next to main.log.`}
          >
            <Input
              type="number"
              min={0}
              step={0.5}
              value={settings.dailyBudgetUsd}
              onChange={(e) => updateSettings({ dailyBudgetUsd: Math.max(0, Number(e.target.value) || 0) })}
              className="h-8 w-28"
            />
          </Row>
          <Row label="Built-in brakes" hint={`At most ${COST_LIMITS.maxTurnsPerMinute} chat turns per minute; only the last ${COST_LIMITS.historyMessages} messages and ${COST_LIMITS.maxCodeChars.toLocaleString()} characters of code are sent; transcripts that echo the assistant's own voice are dropped. When a brake trips, the mic turns off and a red notice appears in the copilot header.`}>
            <span className="text-[11.5px] text-zinc-500">always on</span>
          </Row>
        </div>

        <h2 className="mb-3 mt-8 text-[13px] font-medium text-zinc-300">AI provider</h2>
        <div className="overflow-hidden rounded-xl border border-white/[0.06]">
          {providerStatuses.map((p, i) => (
            <button
              key={p.id}
              onClick={() => updateSettings({ provider: p.id })}
              className={`flex w-full items-center justify-between px-4 py-3 text-left text-[13px] ${
                i !== 0 ? 'border-t border-white/[0.06]' : ''
              } ${settings.provider === p.id ? 'bg-teal-400/[0.06]' : 'hover:bg-white/[0.02]'}`}
            >
              <div className="flex items-center gap-2">
                <span className={`h-1.5 w-1.5 rounded-full ${p.configured ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
                <span className="text-zinc-200">{PROVIDER_LABEL[p.id]}</span>
              </div>
              <span className="text-[11.5px] text-zinc-500">
                {p.configured ? (settings.provider === p.id ? 'Active' : 'Configured') : 'No API key in .env'}
              </span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11.5px] text-zinc-600">
          Chat and chips use the active provider. Inline completions always prefer Groq when it has a key (lowest latency).
        </p>

        <h2 className="mb-3 mt-8 text-[13px] font-medium text-zinc-300">Voice</h2>
        <div className="divide-y divide-white/[0.06] rounded-xl border border-white/[0.06]">
          <Row
            label="Speech engine"
            hint="Windows voices are instant and offline. Edge is Microsoft's neural Ava over the network (~3 s/sentence). Kokoro runs locally on your GPU."
          >
            <select
              value={settings.ttsEngine}
              onChange={(e) => {
                const ttsEngine = e.target.value as TtsEngine
                updateSettings({ ttsEngine, voiceName: DEFAULT_VOICE[ttsEngine] })
              }}
              className={selectClass}
            >
              <option value="webspeech">Windows voices (instant)</option>
              <option value="edge">Edge TTS (Ava, network)</option>
              <option value="kokoro">Kokoro (local GPU)</option>
            </select>
          </Row>
          <Row label="Voice" hint={settings.ttsEngine === 'webspeech' ? `${webVoices.length} voices installed. Partial names work ("Ava").` : 'Ava is the default. Type any voice name the engine knows.'}>
            <div className="flex items-center gap-2">
              <select value={voices.includes(settings.voiceName) ? settings.voiceName : ''} onChange={(e) => e.target.value && updateSettings({ voiceName: e.target.value })} className={selectClass}>
                <option value="">custom…</option>
                {voices.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
              <Input value={settings.voiceName} onChange={(e) => updateSettings({ voiceName: e.target.value })} className="h-8 w-56" />
            </div>
          </Row>
          <Row label="Guided step-by-step mode" hint="One instruction at a time instead of full explanations.">
            <Button size="sm" variant={settings.guidedVoice ? 'default' : 'outline'} onClick={() => updateSettings({ guidedVoice: !settings.guidedVoice })}>
              {settings.guidedVoice ? 'On' : 'Off'}
            </Button>
          </Row>
          <Row
            label="Voice server"
            hint={
              sidecar.status === 'ready'
                ? `Running on port ${sidecar.port} · speech-to-text: ${voice.stt}${voice.sttDetail ? ` (${voice.sttDetail})` : ''}`
                : sidecar.status === 'starting'
                  ? 'Starting Python…'
                  : sidecar.status === 'error'
                    ? sidecar.message ?? 'Failed'
                    : 'Python sidecar (voice/server.py): Silero VAD + Parakeet + Edge/Kokoro. Starts automatically when you turn the mic on.'
            }
          >
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={sidecar.status === 'starting' || sidecar.status === 'ready'} onClick={() => void window.api.voice.start()}>
                Start
              </Button>
              <Button size="sm" variant="outline" disabled={sidecar.status === 'off'} onClick={() => void window.api.voice.stop()}>
                Stop
              </Button>
            </div>
          </Row>
        </div>

        <h2 className="mb-3 mt-8 text-[13px] font-medium text-zinc-300">Editor</h2>
        <div className="divide-y divide-white/[0.06] rounded-xl border border-white/[0.06]">
          <Row label="Inline completions" hint="Copilot-style grey suggestions as you type. Tab accepts, Esc dismisses.">
            <Button size="sm" variant={settings.inlineCompletions ? 'default' : 'outline'} onClick={() => updateSettings({ inlineCompletions: !settings.inlineCompletions })}>
              {settings.inlineCompletions ? 'On' : 'Off'}
            </Button>
          </Row>
          <Row label="Default language">
            <select value={settings.language} onChange={(e) => updateSettings({ language: e.target.value })} className={selectClass}>
              <option value="python">Python</option>
              <option value="sql">SQL</option>
              <option value="javascript">JavaScript</option>
              <option value="java">Java</option>
              <option value="cpp">C++</option>
            </select>
          </Row>
        </div>

        <h2 className="mb-3 mt-8 text-[13px] font-medium text-zinc-300">Keyboard shortcuts</h2>
        <div className="overflow-hidden rounded-xl border border-white/[0.06]">
          {Object.entries(settings.shortcuts).map(([label, combo], i) => (
            <div key={label} className={`flex items-center justify-between px-4 py-3 text-[13px] ${i !== 0 ? 'border-t border-white/[0.06]' : ''}`}>
              <span className="text-zinc-300">{label}</span>
              <span className="rounded-md bg-white/[0.06] px-2 py-0.5 font-mono text-[11.5px] text-zinc-400">{combo}</span>
            </div>
          ))}
        </div>

        <h2 className="mb-3 mt-8 text-[13px] font-medium text-zinc-300">Debug</h2>
        <div className="divide-y divide-white/[0.06] rounded-xl border border-white/[0.06]">
          <Row label="DevTools for this window">
            <Button size="sm" variant="outline" onClick={() => void window.api.debug.openDevtools()}>
              Open DevTools
            </Button>
          </Row>
          <Row label="Main-process log file" hint={logPath ?? undefined}>
            <Button size="sm" variant="outline" onClick={async () => setLogPath(await window.api.debug.getLogPath())}>
              Show path
            </Button>
          </Row>
        </div>
      </div>
    </div>
  )
}
