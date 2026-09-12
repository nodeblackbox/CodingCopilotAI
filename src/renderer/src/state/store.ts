import { create } from 'zustand'
import type {
  ChatMessage,
  ChipId,
  CursorInfo,
  Playground,
  ProviderStatus,
  Question,
  Settings,
  StreamChunkEvent,
  StreamDoneEvent,
  UsageSummary,
  VoiceSidecarState
} from '@shared/types'
import type { SelectionRange } from '@shared/types'
import { ANTHROPIC_MODELS, EDITOR_CMD, SCRATCH_QUESTION_ID } from '@shared/types'
import { QUESTIONS, SCRATCH, isScratch, questionById, starterFor, templateFor } from '@renderer/data/questions'
import { CHIP_DEFS } from '@renderer/data/chips'
import { uid } from '@renderer/lib/utils'
import { SentenceChunker } from '@renderer/lib/sentenceChunker'
import { VoiceClient } from '@renderer/lib/voiceClient'
import { gotoLine, insertAtCursor, readEditorState, revealLine, selectLines } from '@renderer/lib/editorBridge'
import { describeChanges } from '@renderer/lib/diffLines'

/** The editor text as of the last turn we sent, so the next turn can say what changed. */
let codeAtLastTurn: string | null = null

/**
 * User precedence: when the user keeps talking after Smart Turn already closed their turn (and before the
 * assistant has said anything), the half-turn is remembered here so the next transcript is glued onto it.
 */
let pendingContinuation: { userText: string; at: number } | null = null
const CONTINUATION_WINDOW_MS = 10_000

export type View = 'workspace' | 'playgrounds' | 'library' | 'settings'
export type RightMode = 'ask' | 'agent'
export type DiffState = 'pending' | 'accepted' | 'rejected'

interface TerminalLine {
  text: string
}

interface ChipResultUi {
  chipId: ChipId
  title: string
  summary: string
}

export interface VoiceUiState {
  sidecar: VoiceSidecarState
  connecting: boolean
  micOn: boolean
  /** "parakeet" | "loading" | "none" as reported by the sidecar. */
  stt: string
  sttDetail: string
  /** "smart-turn" | "silence" — how end of turn is decided. */
  turn: string
  /** Mic RMS 0..1, throttled; lets the UI prove the mic is live. */
  level: number
  partial: string
  userSpeaking: boolean
  agentSpeaking: boolean
  /** Playback is ducked because you seem to be talking over the assistant. */
  ducked: boolean
  lastError: string | null
}

const DEFAULT_SETTINGS: Settings = {
  provider: 'anthropic',
  aiEnabled: true,
  chatModel: ANTHROPIC_MODELS.haiku,
  dailyBudgetUsd: 2,
  language: 'python',
  guidedVoice: false,
  inlineCompletions: true,
  ttsEngine: 'edge',
  voiceName: 'en-US-AvaNeural',
  voiceVolume: 0.9,
  shortcuts: {}
}

/** Default voice per engine, used when the user switches engines. */
export const DEFAULT_VOICE: Record<Settings['ttsEngine'], string> = {
  webspeech: 'Ava',
  edge: 'en-US-AvaNeural',
  kokoro: 'af_heart'
}

const greeting = (q: Question): ChatMessage => ({
  role: 'assistant',
  text: `Hey! We're on ${q.title}. Want a hint, or would you rather talk through your approach first?`
})

const FILE_EXT: Record<string, string> = { python: 'py', javascript: 'js', sql: 'sql', java: 'java', cpp: 'cpp' }
const fileName = (language: string): string => `solution.${FILE_EXT[language] ?? 'txt'}`

interface AppState {
  // navigation
  view: View
  rightMode: RightMode
  setView: (v: View) => void
  setRightMode: (m: RightMode) => void

  // settings / providers
  settings: Settings
  providerStatuses: ProviderStatus[]
  loadSettings: () => Promise<void>
  updateSettings: (patch: Partial<Settings>) => Promise<void>

  // question + editor
  question: Question
  language: string
  code: string
  setLanguage: (lang: string) => void
  setCode: (code: string) => void
  autosave: 'saved' | 'saving'
  openQuestion: (id: string) => void
  /** Live caret + selection from Monaco, shipped with every chat/voice turn so the copilot knows where you are. */
  editorState: { cursor: CursorInfo; selection: string; selectionRange: SelectionRange | null }
  setEditorState: (s: { cursor: CursorInfo; selection: string; selectionRange: SelectionRange | null }) => void
  /** Free coding: what the user says they're working on (sent instead of a problem statement). */
  scratchNotes: string
  setScratchNotes: (notes: string) => void
  startScratch: () => void
  /** Swap the buffer for the blank signature template or the starter attempt. */
  resetCode: (variant: 'template' | 'starter') => void

  // agent chips
  activeChip: ChipId | null
  chipLoading: boolean
  chipResult: ChipResultUi | null
  diffVisible: boolean
  diffState: DiffState
  proposedCode: string
  selectChip: (chipId: ChipId) => Promise<void>
  acceptDiff: () => void
  rejectDiff: () => void

  // ask chat (streamed)
  messages: ChatMessage[]
  chatSending: boolean
  sendMessage: (text: string, opts?: { speak?: boolean }) => Promise<void>
  cancelReply: () => void

  // voice
  voice: VoiceUiState
  toggleMic: () => Promise<void>
  stopSpeaking: () => void
  /** Speak arbitrary text through the voice pipeline (starts the sidecar if needed; no model call). */
  speakText: (text: string) => Promise<void>
  readQuestionAloud: () => Promise<void>

  // spend meter + brakes
  usage: UsageSummary | null
  /** Set when main refused calls (rate brake / budget / AI off); cleared on the next successful send. */
  pausedReason: string | null
  clearPaused: () => void

  // terminal / run
  terminalOpen: boolean
  running: boolean
  terminalLines: TerminalLine[]
  setTerminalOpen: (open: boolean) => void
  runOrSubmit: (mode: 'run' | 'submit') => Promise<void>

  // playgrounds
  playgrounds: Playground[]
  currentPlaygroundId: string | null
  loadPlaygrounds: () => Promise<void>
  newPlayground: (questionId?: string) => Promise<void>
  openPlayground: (id: string) => Promise<void>

  init: () => Promise<void>
}

/* ── module-level runtime (not React state): timers, the live stream, the voice client ── */

let autosaveTimer: ReturnType<typeof setTimeout> | null = null
let initialized = false
let voice: VoiceClient | null = null

interface LiveStream {
  requestId: string
  speak: boolean
  chunker: SentenceChunker
  /** Everything the model has sent, including command blocks. */
  raw: string
  /** How much of the visible (command-stripped) text has already been shown/spoken. */
  visibleLen: number
  /** How many command blocks have been applied so far. */
  executed: number
  /** "(typed 3 lines at line 4)"-style notes, kept so later chunks don't erase them. */
  notes: string
}
let liveStream: LiveStream | null = null

/** What the agent said recently (visible text), so a transcript that is really our own voice can be dropped. */
let recentAgentSpeech: { text: string; at: number }[] = []
const ECHO_WINDOW_MS = 20_000

const words = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean)

/** True when most of the transcript's words appear in something the agent said in the last 20 s. */
function looksLikeEcho(transcript: string): boolean {
  const now = Date.now()
  recentAgentSpeech = recentAgentSpeech.filter((r) => now - r.at < ECHO_WINDOW_MS)
  const t = words(transcript)
  if (t.length < 3) return false
  const said = new Set(recentAgentSpeech.flatMap((r) => words(r.text)))
  const hits = t.filter((w) => said.has(w)).length
  return hits / t.length >= 0.7
}

interface EditorCommand {
  kind: 'insert' | 'replace' | 'goto' | 'select'
  code: string
}

const CMD_MARKERS: Array<{ kind: EditorCommand['kind']; marker: string }> = [
  { kind: 'insert', marker: EDITOR_CMD.insert },
  { kind: 'replace', marker: EDITOR_CMD.replace },
  { kind: 'goto', marker: EDITOR_CMD.goto },
  { kind: 'select', marker: EDITOR_CMD.select }
]

type NavAction = { kind: 'goto'; line: number } | { kind: 'select'; a: number; b: number }

/**
 * "go to line 12", "highlight lines 3 to 7", "select line 5": handled locally and instantly, no model call.
 * Returns the actions found and whether the message was ONLY navigation (then the model isn't consulted).
 */
export function parseNavIntents(text: string): { actions: NavAction[]; navOnly: boolean } {
  const actions: NavAction[] = []
  let rest = ` ${text} `
  const select = /\b(?:highlight|select|mark|grab)\s+(?:from\s+)?lines?\s+(\d+)\s*(?:to|-|–|through|thru|and|till|until)\s*(?:line\s+)?(\d+)/gi
  const selectOne = /\b(?:highlight|select|mark|grab)\s+line\s+(\d+)\b(?!\s*(?:to|-|–|through|thru|and|till|until))/gi
  const goto = /\b(?:go|jump|move|scroll|take me|bring me)\s*(?:to|on|onto)?\s*line\s+(\d+)/gi
  rest = rest.replace(select, (_m, a: string, b: string) => {
    actions.push({ kind: 'select', a: Number(a), b: Number(b) })
    return ' '
  })
  rest = rest.replace(selectOne, (_m, a: string) => {
    actions.push({ kind: 'select', a: Number(a), b: Number(a) })
    return ' '
  })
  rest = rest.replace(goto, (_m, n: string) => {
    actions.push({ kind: 'goto', line: Number(n) })
    return ' '
  })
  const filler = /\b(please|can you|could you|would you|ok|okay|yo|hey|now|then|and|also|just|for me|the|um|uh|alright|right|so)\b/gi
  const leftover = rest.replace(filler, ' ').replace(/[^a-z0-9]+/gi, ' ').trim()
  return { actions, navOnly: actions.length > 0 && leftover.split(/\s+/).filter(Boolean).length <= 1 }
}

function runNavActions(actions: NavAction[]): string[] {
  const notes: string[] = []
  for (const act of actions) {
    if (act.kind === 'goto') {
      const line = gotoLine(act.line)
      notes.push(line === null ? 'No editor open.' : `Went to line ${line}.`)
    } else {
      const range = selectLines(act.a, act.b)
      notes.push(
        range === null
          ? 'No editor open.'
          : range.startLine === range.endLine
            ? `Highlighted line ${range.startLine}.`
            : `Highlighted lines ${range.startLine}–${range.endLine}.`
      )
    }
  }
  return notes
}

/**
 * Splits a streamed reply into what the user should see/hear and the editor commands embedded in it.
 * A block that hasn't closed yet is hidden entirely (so the caret never shows half a code block), and
 * only closed blocks are returned as commands.
 */
export function splitEditorCommands(raw: string): { visible: string; commands: EditorCommand[] } {
  const commands: EditorCommand[] = []
  let visible = ''
  let pos = 0
  for (;;) {
    const found = CMD_MARKERS.map((m) => ({ ...m, at: raw.indexOf(m.marker, pos) })).filter((m) => m.at >= 0)
    if (!found.length) {
      // Hide a marker that is still being typed out ("<<<INS").
      const tail = raw.slice(pos)
      const partial = tail.lastIndexOf('<<<')
      visible += partial >= 0 && !tail.slice(partial).includes('>>>') ? tail.slice(0, partial) : tail
      break
    }
    const first = found.reduce((a, b) => (b.at < a.at ? b : a))
    visible += raw.slice(pos, first.at)
    const end = raw.indexOf(EDITOR_CMD.end, first.at + first.marker.length)
    if (end < 0) break // block still streaming
    const code = raw.slice(first.at + first.marker.length, end).replace(/^\r?\n/, '').replace(/\s+$/, '')
    commands.push({ kind: first.kind, code })
    pos = end + EDITOR_CMD.end.length
  }
  return { visible: visible.replace(/\n{3,}/g, '\n\n'), commands }
}

async function persistCurrentPlayground(get: () => AppState, id: string): Promise<void> {
  const state = get()
  const existing = await window.api.store.getPlayground(id)
  const name = existing?.activeFile ?? fileName(state.language)
  const playground: Playground = {
    id,
    title: existing?.title ?? 'Untitled attempt',
    questionId: state.question.id,
    files: [{ name, language: state.language, content: state.code }],
    activeFile: name,
    messages: state.messages,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now()
  }
  await window.api.store.savePlayground(playground)
}

/** A different problem than the current one, preferring ones not started yet. */
function pickNextQuestion(currentId: string): Question {
  const others = QUESTIONS.filter((q) => q.id !== currentId)
  const fresh = others.filter((q) => q.status === 'not_started')
  const pool = fresh.length ? fresh : others.length ? others : QUESTIONS
  return pool[Math.floor(Math.random() * pool.length)]
}

export const useAppStore = create<AppState>((set, get) => {
  const speakSentences = (sentences: string[]): void => {
    const { settings } = get()
    for (const s of sentences) voice?.speak(s, settings.ttsEngine, settings.voiceName)
  }

  const setLastAssistant = (text: string): void => {
    set((s) => {
      const messages = s.messages.slice()
      const last = messages[messages.length - 1]
      if (last?.role === 'assistant') messages[messages.length - 1] = { ...last, text }
      return { messages }
    })
  }

  const applyEditorCommand = (cmd: EditorCommand): string => {
    if (cmd.kind === 'goto') {
      const n = Number.parseInt(cmd.code, 10)
      if (!Number.isFinite(n)) return ''
      const line = gotoLine(n)
      return line === null ? '' : ` _(→ line ${line})_`
    }
    if (cmd.kind === 'select') {
      const m = cmd.code.match(/(\d+)\s*(?:-|–|to|,)?\s*(\d+)?/)
      if (!m) return ''
      const range = selectLines(Number(m[1]), Number(m[2] ?? m[1]))
      if (!range) return ''
      return range.startLine === range.endLine ? ` _(highlighted line ${range.startLine})_` : ` _(highlighted lines ${range.startLine}–${range.endLine})_`
    }
    if (cmd.kind === 'replace') {
      set({
        proposedCode: cmd.code,
        diffVisible: true,
        diffState: 'pending',
        activeChip: null,
        chipResult: { chipId: 'generate', title: 'Proposed in chat', summary: 'Review the diff in the editor.' }
      })
      return ' _(proposed a rewrite — accept or reject it in the editor)_'
    }
    const line = insertAtCursor(cmd.code)
    if (line === null) {
      // No live editor (another view is open): append to the buffer so nothing is lost.
      set((s) => ({ code: s.code.replace(/\s*$/, '') + '\n' + cmd.code }))
      return ' _(added to the end of the file)_'
    }
    revealLine(line)
    const n = cmd.code.split('\n').length
    return ` _(typed ${n} line${n === 1 ? '' : 's'} at line ${line})_`
  }

  /** Re-derive visible text + commands from everything received so far; show/speak/apply only the new parts. */
  const ingest = (stream: LiveStream): void => {
    const { visible, commands } = splitEditorCommands(stream.raw)
    while (stream.executed < commands.length) {
      stream.notes += applyEditorCommand(commands[stream.executed])
      stream.executed += 1
    }
    if (visible.length > stream.visibleLen) {
      const fresh = visible.slice(stream.visibleLen)
      stream.visibleLen = visible.length
      if (stream.speak) {
        recentAgentSpeech.push({ text: fresh, at: Date.now() })
        speakSentences(stream.chunker.feed(fresh))
      }
    }
    setLastAssistant(visible.replace(/\s+$/, '') + stream.notes)
  }

  const onChunk = (e: StreamChunkEvent): void => {
    if (!liveStream || e.requestId !== liveStream.requestId) return
    liveStream.raw += e.delta
    ingest(liveStream)
  }

  const onDone = (e: StreamDoneEvent): void => {
    if (!liveStream || e.requestId !== liveStream.requestId) return
    const stream = liveStream
    liveStream = null
    if (e.error) {
      setLastAssistant(splitEditorCommands(stream.raw).visible + `\n\nCopilot error: ${e.error}`)
      // A refusal from the brakes/budget/off-switch: stop listening so a voice loop can't keep retrying.
      if (/paused|budget|switched off/i.test(e.error)) {
        set({ pausedReason: e.error })
        if (get().voice.micOn) void get().toggleMic()
      }
    } else if (!e.cancelled) {
      ingest(stream)
      if (stream.speak) speakSentences(stream.chunker.flush())
    }
    set((s) => {
      const messages = s.messages.slice()
      const last = messages[messages.length - 1]
      if (e.cancelled && last?.role === 'assistant' && !last.text.trim()) messages.pop()
      return { messages, chatSending: false }
    })
    const { currentPlaygroundId } = get()
    if (currentPlaygroundId) void persistCurrentPlayground(get, currentPlaygroundId)
  }

  const setVoice = (patch: Partial<VoiceUiState>): void => set((s) => ({ voice: { ...s.voice, ...patch } }))

  const ensureVoiceClient = async (port: number): Promise<VoiceClient> => {
    if (voice?.connected) return voice
    voice?.close()
    const client = new VoiceClient({
      onReady: ({ stt, detail, turn }) => setVoice({ stt, sttDetail: detail, turn }),
      onLevel: (level) => setVoice({ level }),
      onPartial: (text) => setVoice({ partial: text }),
      onVad: (speaking) => {
        setVoice({ userSpeaking: speaking, ...(speaking ? {} : { partial: '' }) })
        if (!speaking) return
        // The user always has precedence. Talking while the reply is still being generated (no audio yet)
        // means their turn wasn't over: drop the reply, remember the half-turn, and merge on the next final.
        const { chatSending, voice: v, messages } = get()
        if (chatSending && !v.agentSpeaking) {
          const lastUser = [...messages].reverse().find((m) => m.role === 'user')
          if (lastUser) pendingContinuation = { userText: lastUser.text, at: Date.now() }
          get().cancelReply()
          set((s) => {
            const m = s.messages.slice()
            // remove the dangling half-turn (and any partial reply) so history stays clean
            if (m[m.length - 1]?.role === 'assistant') m.pop()
            if (m[m.length - 1]?.role === 'user') m.pop()
            return { messages: m }
          })
        }
      },
      onDuck: (on) => setVoice({ ducked: on }),
      onBargeIn: () => {
        setVoice({ ducked: false })
        get().stopSpeaking()
      },
      onFinal: (text) => {
        setVoice({ partial: '' })
        if (looksLikeEcho(text)) {
          // The mic heard the agent's own voice (speakers, no headphones). Never turn that into a paid turn.
          setVoice({ lastError: `Ignored echo of the assistant: “${text.slice(0, 60)}…”` })
          return
        }
        let turn = text
        if (pendingContinuation && Date.now() - pendingContinuation.at < CONTINUATION_WINDOW_MS) {
          turn = `${pendingContinuation.userText} ${text}`
        }
        pendingContinuation = null
        void get().sendMessage(turn, { speak: true })
      },
      onPlaybackChange: (playing) => setVoice({ agentSpeaking: playing }),
      onError: (message) => setVoice({ lastError: message }),
      onClose: () => {
        voice = null
        setVoice({ micOn: false, agentSpeaking: false, connecting: false })
      }
    })
    await client.connect(port)
    client.setVolume(get().settings.voiceVolume)
    voice = client
    return client
  }

  return {
    view: 'workspace',
    rightMode: 'agent',
    setView: (v) => set({ view: v }),
    setRightMode: (m) => set({ rightMode: m }),

    settings: DEFAULT_SETTINGS,
    providerStatuses: [],
    loadSettings: async () => {
      const [settings, providerStatuses] = await Promise.all([
        window.api.store.getSettings(),
        window.api.ai.providerStatus()
      ])
      set({ settings: { ...DEFAULT_SETTINGS, ...settings }, providerStatuses })
    },
    updateSettings: async (patch) => {
      const next = { ...get().settings, ...patch }
      set({ settings: next })
      if (patch.voiceVolume !== undefined) voice?.setVolume(patch.voiceVolume)
      await window.api.store.setSettings(next)
    },

    question: QUESTIONS[0],
    language: 'python',
    code: starterFor(QUESTIONS[0], 'python'),
    autosave: 'saved',
    setLanguage: (lang) => set({ language: lang, code: starterFor(get().question, lang) }),
    setCode: (code) => {
      set({ code, autosave: 'saving' })
      if (autosaveTimer) clearTimeout(autosaveTimer)
      autosaveTimer = setTimeout(async () => {
        const { currentPlaygroundId } = get()
        if (currentPlaygroundId) await persistCurrentPlayground(get, currentPlaygroundId)
        set({ autosave: 'saved' })
      }, 500)
    },
    editorState: { cursor: { line: 1, column: 1 }, selection: '', selectionRange: null },
    setEditorState: (editorState) => set({ editorState }),
    scratchNotes: '',
    setScratchNotes: (scratchNotes) => set({ scratchNotes }),
    startScratch: () => {
      get().cancelReply()
      codeAtLastTurn = null
      set({
        question: SCRATCH,
        code: starterFor(SCRATCH, get().language),
        currentPlaygroundId: null,
        messages: [{ role: 'assistant', text: "Free coding — no problem loaded. Tell me what you're working on (the notes box on the left goes with every turn) or just start typing." }],
        activeChip: null,
        chipResult: null,
        diffVisible: false,
        proposedCode: '',
        view: 'workspace'
      })
    },
    resetCode: (variant) => {
      const { question, language } = get()
      set({ code: variant === 'template' ? templateFor(question, language) : starterFor(question, language), diffVisible: false, proposedCode: '' })
    },
    openQuestion: (id) => {
      const q = questionById(id)
      if (!q) return
      get().cancelReply()
      codeAtLastTurn = null
      set({
        question: q,
        code: starterFor(q, get().language),
        currentPlaygroundId: null,
        messages: [greeting(q)],
        activeChip: null,
        chipResult: null,
        diffVisible: false,
        proposedCode: '',
        view: 'workspace'
      })
    },

    activeChip: null,
    chipLoading: false,
    chipResult: null,
    diffVisible: false,
    diffState: 'pending',
    proposedCode: '',
    selectChip: async (chipId) => {
      const def = CHIP_DEFS.find((c) => c.id === chipId)!
      const { question, language, code, scratchNotes } = get()
      set({ activeChip: chipId, chipLoading: true, chipResult: null })
      if (def.diff) set({ diffVisible: true, diffState: 'pending', proposedCode: '' })
      else set({ diffVisible: false })

      const snap = readEditorState()
      const res = await window.api.ai.chip({
        chipId,
        questionTitle: question.title,
        questionPrompt: isScratch(question)
          ? `Free coding session (no assigned problem). The user says they're working on: ${scratchNotes || '(not stated)'}`
          : question.prompt,
        language,
        // A highlighted region scopes the chip: "Explain problem" on a selection explains that code.
        code: snap?.selection ? `${code}\n\n# The user has HIGHLIGHTED lines ${snap.selectionRange?.startLine}-${snap.selectionRange?.endLine}; focus on them:\n${snap.selection}` : code
      })

      set((s) => ({
        chipLoading: false,
        chipResult: { chipId, title: def.label, summary: res.summary },
        proposedCode: res.proposedCode ?? '',
        // A diff chip that came back without code (provider error) has nothing to accept.
        ...(def.diff && !res.proposedCode ? { diffVisible: false } : {}),
        // Also land it in the thread: it stays visible in Ask mode and becomes context for later turns.
        messages: [...s.messages, { role: 'assistant', text: `**${def.label}**\n\n${res.summary}` }]
      }))
      if (get().voice.micOn && !res.summary.startsWith('Copilot error')) {
        recentAgentSpeech.push({ text: res.summary, at: Date.now() })
        speakSentences(new SentenceChunker().feed(res.summary + ' '))
      }
    },
    acceptDiff: () => {
      if (!get().proposedCode) return
      set((s) => ({ code: s.proposedCode, diffState: 'accepted', autosave: 'saving' }))
      setTimeout(() => set({ diffVisible: false, autosave: 'saved' }), 500)
    },
    rejectDiff: () => {
      set({ diffState: 'rejected' })
      setTimeout(() => set({ diffVisible: false }), 500)
    },

    messages: [greeting(QUESTIONS[0])],
    chatSending: false,
    sendMessage: async (text, opts = {}) => {
      const trimmed = text.trim()
      if (!trimmed) return
      get().cancelReply() // a new turn always supersedes the previous reply (typed or spoken)
      set({ pausedReason: null })

      // Navigation ("go to line 12", "highlight lines 3 to 7") is done locally first, so the model sees the
      // result; when that's all the message was, no model call is made at all.
      const nav = parseNavIntents(trimmed)
      if (nav.actions.length) {
        const notes = runNavActions(nav.actions)
        if (nav.navOnly) {
          const reply = notes.join(' ')
          set((s) => ({ messages: [...s.messages, { role: 'user', text: trimmed }, { role: 'assistant', text: reply }] }))
          if (opts.speak) void get().speakText(reply)
          return
        }
      }

      const { question, language, code, settings, messages, scratchNotes } = get()
      // Read the caret/selection straight from Monaco (the store copy is throttled and could be 120 ms stale).
      const editorState = readEditorState() ?? get().editorState
      const history: ChatMessage[] = [...messages, { role: 'user', text: trimmed }]
      const requestId = uid()
      liveStream = { requestId, speak: Boolean(opts.speak), chunker: new SentenceChunker(), raw: '', visibleLen: 0, executed: 0, notes: '' }
      set({ messages: [...history, { role: 'assistant', text: '' }], chatSending: true })
      const recentChanges = codeAtLastTurn === null ? '' : describeChanges(codeAtLastTurn, code)
      codeAtLastTurn = code
      await window.api.ai.askStream({
        requestId,
        messages: history,
        guidedVoice: settings.guidedVoice,
        spoken: Boolean(opts.speak),
        questionTitle: question.title,
        questionPrompt: isScratch(question) ? scratchNotes : question.prompt,
        mode: isScratch(question) ? 'scratch' : 'interview',
        language,
        code,
        cursor: editorState.cursor,
        selection: editorState.selection,
        selectionRange: editorState.selectionRange ?? undefined,
        recentChanges
      })
    },
    cancelReply: () => {
      if (liveStream) {
        void window.api.ai.cancelStream(liveStream.requestId)
        // Don't wait for the cancelled event: clear immediately so a follow-up turn can start.
        liveStream = null
        set((s) => {
          const messages = s.messages.slice()
          const last = messages[messages.length - 1]
          if (last?.role === 'assistant' && !last.text.trim()) messages.pop()
          return { messages, chatSending: false }
        })
      }
      voice?.stopSpeaking()
    },

    voice: {
      sidecar: { status: 'off', port: null },
      connecting: false,
      micOn: false,
      stt: 'none',
      sttDetail: '',
      turn: '',
      level: 0,
      partial: '',
      userSpeaking: false,
      agentSpeaking: false,
      ducked: false,
      lastError: null
    },
    toggleMic: async () => {
      const { voice: v } = get()
      if (v.micOn) {
        voice?.stopMic()
        setVoice({ micOn: false, partial: '', userSpeaking: false, level: 0 })
        return
      }
      setVoice({ connecting: true, lastError: null })
      try {
        let sidecar = v.sidecar
        if (sidecar.status !== 'ready') sidecar = await window.api.voice.start()
        setVoice({ sidecar })
        if (sidecar.status !== 'ready' || !sidecar.port) {
          throw new Error(sidecar.message ?? 'Voice server is not available')
        }
        const client = await ensureVoiceClient(sidecar.port)
        await client.startMic()
        setVoice({ micOn: true, connecting: false })
      } catch (err) {
        setVoice({ connecting: false, micOn: false, lastError: (err as Error).message })
      }
    },
    stopSpeaking: () => {
      get().cancelReply()
    },
    speakText: async (text) => {
      const trimmed = text.trim()
      if (!trimmed) return
      setVoice({ lastError: null })
      try {
        let sidecar = get().voice.sidecar
        if (sidecar.status !== 'ready') {
          setVoice({ connecting: true })
          sidecar = await window.api.voice.start()
          setVoice({ sidecar, connecting: false })
        }
        if (sidecar.status !== 'ready' || !sidecar.port) throw new Error(sidecar.message ?? 'Voice server is not available')
        await ensureVoiceClient(sidecar.port)
        voice?.stopSpeaking()
        recentAgentSpeech.push({ text: trimmed, at: Date.now() })
        const chunker = new SentenceChunker()
        speakSentences([...chunker.feed(trimmed + ' '), ...chunker.flush()])
      } catch (err) {
        setVoice({ connecting: false, lastError: (err as Error).message })
      }
    },
    readQuestionAloud: async () => {
      const q = get().question
      const examples = q.examples.map((e) => `${e.heading}. ${e.lines.join('. ')}`).join(' ')
      await get().speakText(`${q.title}. ${q.prompt} ${examples} Constraints: ${q.constraints.join('; ')}.`)
    },

    usage: null,
    pausedReason: null,
    clearPaused: () => set({ pausedReason: null }),

    terminalOpen: false,
    running: false,
    terminalLines: [{ text: 'Ready.' }],
    setTerminalOpen: (open) => set({ terminalOpen: open }),
    runOrSubmit: async (mode) => {
      const { code, language } = get()
      const label = mode === 'submit' ? 'submit' : `python solution.py`
      set((s) => ({
        terminalOpen: true,
        running: true,
        terminalLines: [...s.terminalLines, { text: `$ ${label}` }, { text: 'Running…' }]
      }))

      const result = await window.api.run.code({ code, language })
      const summary = result.timedOut
        ? 'Timed out.'
        : result.ok
          ? `Exited 0 in ${result.durationMs}ms`
          : `Exited ${result.exitCode} in ${result.durationMs}ms`

      const lines: TerminalLine[] = []
      if (result.stdout) lines.push(...result.stdout.split('\n').map((text) => ({ text })))
      if (result.stderr) lines.push(...result.stderr.split('\n').map((text) => ({ text: `stderr: ${text}` })))
      lines.push({ text: summary })

      set((s) => ({
        running: false,
        terminalLines: [...s.terminalLines.slice(0, -1), ...lines]
      }))
    },

    playgrounds: [],
    currentPlaygroundId: null,
    loadPlaygrounds: async () => {
      const playgrounds = await window.api.store.listPlaygrounds()
      set({ playgrounds })
    },
    newPlayground: async (questionId) => {
      const { language, question: current } = get()
      const question = (questionId && questionById(questionId)) || pickNextQuestion(current.id)
      get().cancelReply()
      codeAtLastTurn = null
      const name = fileName(language)
      const playground: Playground = {
        id: uid(),
        title: `${question.title} — attempt`,
        questionId: question.id,
        files: [{ name, language, content: starterFor(question, language) }],
        activeFile: name,
        messages: [greeting(question)],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      await window.api.store.savePlayground(playground)
      set({
        currentPlaygroundId: playground.id,
        question,
        code: playground.files[0].content,
        messages: playground.messages,
        activeChip: null,
        chipResult: null,
        diffVisible: false,
        proposedCode: '',
        view: 'workspace'
      })
      await get().loadPlaygrounds()
    },
    openPlayground: async (id) => {
      const playground = await window.api.store.getPlayground(id)
      if (!playground) return
      get().cancelReply()
      codeAtLastTurn = null
      const question = (playground.questionId === SCRATCH_QUESTION_ID ? SCRATCH : questionById(playground.questionId)) ?? QUESTIONS[0]
      const file = playground.files.find((f) => f.name === playground.activeFile) ?? playground.files[0]
      set({
        currentPlaygroundId: id,
        question,
        code: file?.content ?? '',
        language: file?.language ?? 'python',
        messages: playground.messages.length ? playground.messages : [greeting(question)],
        activeChip: null,
        chipResult: null,
        diffVisible: false,
        proposedCode: '',
        view: 'workspace'
      })
    },

    init: async () => {
      if (!initialized) {
        initialized = true
        window.api.ai.onStreamChunk(onChunk)
        window.api.ai.onStreamDone(onDone)
        window.api.ai.onUsage(({ summary }) => set({ usage: summary }))
        window.api.ai.onPaused((reason) => {
          set({ pausedReason: reason })
          get().cancelReply()
          if (get().voice.micOn) void get().toggleMic()
        })
        void window.api.ai.usageSummary().then((usage) => set({ usage }))
        window.api.voice.onStateChanged((sidecar) => {
          setVoice({ sidecar, ...(sidecar.status !== 'ready' ? { micOn: false, agentSpeaking: false } : {}) })
          if (sidecar.status !== 'ready') {
            voice?.close()
            voice = null
          }
        })
      }
      await get().loadSettings()
      await get().loadPlaygrounds()
      setVoice({ sidecar: await window.api.voice.status() })
    }
  }
})
