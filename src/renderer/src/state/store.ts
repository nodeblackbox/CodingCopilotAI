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
  VoiceSidecarState
} from '@shared/types'
import { EDITOR_CMD } from '@shared/types'
import { QUESTIONS, questionById, starterFor } from '@renderer/data/questions'
import { CHIP_DEFS } from '@renderer/data/chips'
import { uid } from '@renderer/lib/utils'
import { SentenceChunker } from '@renderer/lib/sentenceChunker'
import { VoiceClient } from '@renderer/lib/voiceClient'
import { insertAtCursor, revealLine } from '@renderer/lib/editorBridge'

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
  lastError: string | null
}

const DEFAULT_SETTINGS: Settings = {
  provider: 'anthropic',
  language: 'python',
  guidedVoice: false,
  inlineCompletions: true,
  ttsEngine: 'edge',
  voiceName: 'en-US-AvaNeural',
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
  editorState: { cursor: CursorInfo; selection: string }
  setEditorState: (s: { cursor: CursorInfo; selection: string }) => void

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

interface EditorCommand {
  kind: 'insert' | 'replace'
  code: string
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
    const iIns = raw.indexOf(EDITOR_CMD.insert, pos)
    const iRep = raw.indexOf(EDITOR_CMD.replace, pos)
    const starts = [iIns, iRep].filter((i) => i >= 0)
    if (!starts.length) {
      // Hide a marker that is still being typed out ("<<<INS").
      const tail = raw.slice(pos)
      const partial = tail.lastIndexOf('<<<')
      visible += partial >= 0 && !tail.slice(partial).includes('>>>') ? tail.slice(0, partial) : tail
      break
    }
    const start = Math.min(...starts)
    const kind: EditorCommand['kind'] = start === iIns ? 'insert' : 'replace'
    const marker = kind === 'insert' ? EDITOR_CMD.insert : EDITOR_CMD.replace
    visible += raw.slice(pos, start)
    const end = raw.indexOf(EDITOR_CMD.end, start + marker.length)
    if (end < 0) break // block still streaming
    const code = raw.slice(start + marker.length, end).replace(/^\r?\n/, '').replace(/\s+$/, '')
    commands.push({ kind, code })
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
      if (stream.speak) speakSentences(stream.chunker.feed(fresh))
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
    if (e.error) setLastAssistant(splitEditorCommands(stream.raw).visible + `\n\nCopilot error: ${e.error}`)
    else if (!e.cancelled) {
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
      onVad: (speaking) => setVoice({ userSpeaking: speaking, ...(speaking ? {} : { partial: '' }) }),
      onBargeIn: () => get().stopSpeaking(),
      onFinal: (text) => {
        setVoice({ partial: '' })
        set({ rightMode: 'ask' })
        void get().sendMessage(text, { speak: true })
      },
      onPlaybackChange: (playing) => setVoice({ agentSpeaking: playing }),
      onError: (message) => setVoice({ lastError: message }),
      onClose: () => {
        voice = null
        setVoice({ micOn: false, agentSpeaking: false, connecting: false })
      }
    })
    await client.connect(port)
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
    editorState: { cursor: { line: 1, column: 1 }, selection: '' },
    setEditorState: (editorState) => set({ editorState }),
    openQuestion: (id) => {
      const q = questionById(id)
      if (!q) return
      get().cancelReply()
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
      const { question, language, code } = get()
      set({ activeChip: chipId, chipLoading: true, chipResult: null })
      if (def.diff) set({ diffVisible: true, diffState: 'pending', proposedCode: '' })
      else set({ diffVisible: false })

      const res = await window.api.ai.chip({
        chipId,
        questionTitle: question.title,
        questionPrompt: question.prompt,
        language,
        code
      })

      set({
        chipLoading: false,
        chipResult: { chipId, title: def.label, summary: res.summary },
        proposedCode: res.proposedCode ?? '',
        // A diff chip that came back without code (provider error) has nothing to accept.
        ...(def.diff && !res.proposedCode ? { diffVisible: false } : {})
      })
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
      const { question, language, code, settings, messages, editorState } = get()
      const history: ChatMessage[] = [...messages, { role: 'user', text: trimmed }]
      const requestId = uid()
      liveStream = { requestId, speak: Boolean(opts.speak), chunker: new SentenceChunker(), raw: '', visibleLen: 0, executed: 0, notes: '' }
      set({ messages: [...history, { role: 'assistant', text: '' }], chatSending: true })
      await window.api.ai.askStream({
        requestId,
        messages: history,
        guidedVoice: settings.guidedVoice,
        spoken: Boolean(opts.speak),
        questionTitle: question.title,
        questionPrompt: question.prompt,
        language,
        code,
        cursor: editorState.cursor,
        selection: editorState.selection
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
        set({ rightMode: 'ask' })
      } catch (err) {
        setVoice({ connecting: false, micOn: false, lastError: (err as Error).message })
      }
    },
    stopSpeaking: () => {
      get().cancelReply()
    },

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
      const question = questionById(playground.questionId) ?? QUESTIONS[0]
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
