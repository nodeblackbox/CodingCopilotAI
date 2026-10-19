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
import { ANTHROPIC_MODELS, EDITOR_CMD, SCRATCH_QUESTION_ID, SILENT_REPLY } from '@shared/types'
import { QUESTIONS, SCRATCH, isScratch, questionById, starterFor, templateFor } from '@renderer/data/questions'
import { CHIP_DEFS } from '@renderer/data/chips'
import { uid } from '@renderer/lib/utils'
import { SentenceChunker } from '@renderer/lib/sentenceChunker'
import { VoiceClient } from '@renderer/lib/voiceClient'
import { gotoLine, insertAtCursor, readEditorState, replaceAll, replaceLines, revealLine, selectLines } from '@renderer/lib/editorBridge'
import { describeChanges } from '@renderer/lib/diffLines'
import { slog } from '@renderer/lib/sessionLog'
import { INLINE_DEFAULTS, parseGhostCommand } from '@shared/inline'
import { localIntent, normalizeSpokenNumbers, wantsClearFile, wantsSolution } from '@shared/voiceIntents'

/** The user's latest turn, so a whole-file rewrite can be checked against what they actually asked for. */
let lastUserTurn = ''

/** The editor text as of the last turn we sent, so the next turn can say what changed. */
let codeAtLastTurn: string | null = null

/**
 * User precedence: when the user keeps talking after Smart Turn already closed their turn (and before the
 * assistant has said anything), the half-turn is remembered here so the next transcript is glued onto it.
 */
let pendingContinuation: { userText: string; at: number } | null = null
const CONTINUATION_WINDOW_MS = 10_000

/** The last thing the user said out loud, so ghost text can follow a spoken instruction ("now write the loop"). */
let lastSpoken: { text: string; at: number } | null = null
const SPOKEN_INTENT_WINDOW_MS = 120_000

export function recentSpokenIntent(): string {
  return lastSpoken && Date.now() - lastSpoken.at < SPOKEN_INTENT_WINDOW_MS ? lastSpoken.text.slice(0, 300) : ''
}

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
  /** Mic capture keeps running (level meter still moves) but audio is dropped before it reaches the model. */
  micMuted: boolean
  /** Also silences the assistant's voice. Forces micMuted on; undeafening leaves you muted. */
  deafened: boolean
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
  ...INLINE_DEFAULTS,
  helpStyle: 'coach',
  autoApplyEdits: true,
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
  sendMessage: (text: string, opts?: { speak?: boolean; heard?: string }) => Promise<void>
  cancelReply: () => void
  /** Standing facts/preferences for this session (the copilot adds them; the user can remove them). */
  notes: string[]
  removeNote: (index: number) => void
  /** Set once the user explicitly asks for the answer ("I give up"); unlocks the solution in coach/guided styles. */
  solutionUnlocked: boolean
  /** Text of the latest Run, sent with each turn. */
  lastRun: string
  /** Buffer before the copilot's latest edit, for the Undo button. */
  lastAiEdit: { before: string; after: string; label: string } | null
  undoAiEdit: () => void

  // voice
  voice: VoiceUiState
  toggleMic: () => Promise<void>
  toggleMute: () => void
  toggleDeafen: () => void
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
let settingsSaveTimer: ReturnType<typeof setTimeout> | null = null
const SETTINGS_SAVE_DEBOUNCE_MS = 300
let initialized = false
let voice: VoiceClient | null = null

interface LiveStream {
  requestId: string
  startedAt: number
  firstChunkAt: number | null
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

/** Share (0..1) of the transcript's words that appear in something the agent said in the last 20 s. */
function echoOverlap(transcript: string): number {
  const now = Date.now()
  recentAgentSpeech = recentAgentSpeech.filter((r) => now - r.at < ECHO_WINDOW_MS)
  const t = words(transcript)
  if (t.length < 3) return 0
  const said = new Set(recentAgentSpeech.flatMap((r) => words(r.text)))
  return t.filter((w) => said.has(w)).length / t.length
}

const ECHO_THRESHOLD = 0.7

/** Looks like a navigation/selection request ("go to line twelve", "highlight lines three to seven") the regexes can't parse. */
const NAV_HINT = /\b(go|jump|scroll|move|take me|bring me|highlight|select|mark|grab)\b[^.?!]*\bline/i

/** Derived, human-readable voice state — what the UI would show. Logged on every change so a run reads as a state machine. */
function deriveVoiceState(s: { voice: VoiceUiState; chatSending: boolean; pausedReason: string | null }): string {
  const v = s.voice
  if (v.sidecar.status === 'error') return 'error'
  if (v.sidecar.status === 'starting') return 'loading_sidecar'
  if (v.connecting) return 'connecting'
  if (!v.micOn) return s.pausedReason ? 'paused_brake' : 'idle'
  if (s.pausedReason) return 'paused_brake'
  if (v.deafened) return 'deafened'
  if (v.agentSpeaking) return v.userSpeaking ? 'agent_speaking+user_speaking' : 'agent_speaking'
  if (v.userSpeaking) return 'user_speaking'
  if (s.chatSending) return 'thinking'
  if (v.micMuted) return 'muted'
  return 'listening'
}

interface EditorCommand {
  kind: 'insert' | 'replace' | 'goto' | 'select' | 'lines' | 'run' | 'note'
  code: string
}

const CMD_MARKERS: Array<{ kind: EditorCommand['kind']; marker: string }> = [
  { kind: 'insert', marker: EDITOR_CMD.insert },
  { kind: 'replace', marker: EDITOR_CMD.replace },
  { kind: 'goto', marker: EDITOR_CMD.goto },
  { kind: 'select', marker: EDITOR_CMD.select },
  { kind: 'lines', marker: EDITOR_CMD.lines },
  { kind: 'run', marker: EDITOR_CMD.run },
  { kind: 'note', marker: EDITOR_CMD.note }
]

/** Session notes kept beyond the history window ("doing brute force first"). */
const MAX_NOTES = 8

/** Per-problem state that must not leak into the next problem. */
const FRESH_SESSION = { notes: [] as string[], solutionUnlocked: false, lastRun: '', lastAiEdit: null as AppState['lastAiEdit'] }

/** Text the TTS engine can actually say: markdown stripped; null when nothing pronounceable is left ("**", ")"). */
export function speakable(s: string): string | null {
  const t = s
    .replace(/_\([^)]*\)_/g, ' ')
    .replace(/[*_`#>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return /[a-z0-9]/i.test(t) ? t : null
}

const nonEmptyLines = (s: string): number => s.split('\n').filter((l) => l.trim()).length

/** The model's "nothing to say" reply (or, with `partial`, a prefix of it that is still streaming). */
function looksSilent(visible: string, partial = false): boolean {
  // Models also write it as "<<<SILENT>>>" or "silent." — all mean the same.
  const t = visible.trim().toLowerCase().replace(/\.$/, '').replace(/^<<<|>>>$/g, '').replace(/^\(|\)$/g, '')
  const word = SILENT_REPLY.replace(/[()]/g, '')
  if (partial) return visible.trim().length > 0 && (word.startsWith(t) || /^[(<]+$/.test(visible.trim()))
  return t === word
}

/**
 * Models often drop the indentation of the FIRST line of a LINES body (it sits right after the marker).
 * When that line starts at column 0 but the line it replaces was indented, give it the original indentation.
 */
export function fixFirstLineIndent(body: string, originalFirstLine: string): string {
  const lines = body.split('\n')
  const origIndent = originalFirstLine.match(/^[ \t]*/)?.[0] ?? ''
  if (!origIndent || !lines[0].trim() || /^[ \t]/.test(lines[0])) return body
  const rest = lines.slice(1).filter((l) => l.trim())
  // only when the rest of the body is indented like real code at that depth (or there is no rest)
  if (rest.length && !rest.every((l) => /^[ \t]/.test(l))) return body
  lines[0] = origIndent + lines[0]
  return lines.join('\n')
}

type NavAction = { kind: 'goto'; line: number } | { kind: 'select'; a: number; b: number }

/**
 * "go to line 12", "highlight lines 3 to 7", "select line 5": handled locally and instantly, no model call.
 * Returns the actions found and whether the message was ONLY navigation (then the model isn't consulted).
 */
export function parseNavIntents(text: string): { actions: NavAction[]; navOnly: boolean } {
  const actions: NavAction[] = []
  // Speech-to-text writes "go to line four": numbers become digits for parsing only.
  let rest = ` ${normalizeSpokenNumbers(text)} `
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
    for (const s of sentences) {
      const say = speakable(s)
      if (say) voice?.speak(say, settings.ttsEngine, settings.voiceName)
    }
  }

  /** Drop the live reply and stop speaking. `reason` lands in the conversation log (barge-in vs brake vs user…). */
  const cancel = (reason: string): void => {
    // Talked over / stopped mid-sentence: remember what they actually heard so the next turn knows.
    const heard = get().voice.agentSpeaking ? voice?.heardSoFar() : null
    if (heard !== null && heard !== undefined) {
      let marked = false
      set((s) => {
        const messages = s.messages.slice()
        const i = messages.map((m) => m.role).lastIndexOf('assistant')
        if (i < 0 || messages[i].heard !== undefined) return {}
        const full = speakable(messages[i].text) ?? ''
        if (heard.replace(/…$/, '').length >= full.length - 2) return {} // they heard it all
        messages[i] = { ...messages[i], heard }
        marked = true
        return { messages }
      })
      if (marked) slog('convo', 'cut_off', { reason, heard: heard.slice(0, 300) })
    }
    if (liveStream) {
      const dropped = liveStream
      slog('convo', 'assistant_cancelled', {
        requestId: dropped.requestId,
        reason,
        partial: splitEditorCommands(dropped.raw).visible.slice(0, 300),
        afterMs: Date.now() - dropped.startedAt
      })
      void window.api.ai.cancelStream(dropped.requestId)
      // Don't wait for the cancelled event: clear immediately so a follow-up turn can start.
      liveStream = null
      set((s) => {
        const messages = s.messages.slice()
        const last = messages[messages.length - 1]
        if (last?.role === 'assistant' && !last.text.trim()) messages.pop()
        return { messages, chatSending: false }
      })
    } else if (voice?.connected && get().voice.agentSpeaking) {
      slog('convo', 'speech_cancelled', { reason })
    }
    voice?.stopSpeaking()
  }

  const setLastAssistant = (text: string): void => {
    set((s) => {
      const messages = s.messages.slice()
      const last = messages[messages.length - 1]
      if (last?.role === 'assistant') messages[messages.length - 1] = { ...last, text }
      return { messages }
    })
  }

  const applyEditorCommand = (cmd: EditorCommand, requestId?: string): string => {
    const note = applyEditorCommandInner(cmd)
    // goto/select that silently did nothing (bad number, no editor) are the ones worth flagging.
    const failed = (cmd.kind === 'goto' || cmd.kind === 'select' || cmd.kind === 'lines') && note === ''
    const arg = cmd.kind === 'goto' || cmd.kind === 'select' ? cmd.code.slice(0, 40) : cmd.kind === 'lines' ? cmd.code.split('\n')[0].slice(0, 40) : cmd.kind === 'note' ? cmd.code.slice(0, 160) : undefined
    slog('convo', failed ? 'editor_cmd_failed' : 'editor_cmd', { requestId, kind: cmd.kind, arg, chars: cmd.code.length, result: note.trim() }, failed ? 'warn' : 'info')
    return note
  }

  /** Remember the buffer around a copilot edit; Undo is offered only while the file is still exactly `after`. */
  const markAiEdit = (before: string, label: string): void => set({ lastAiEdit: { before, after: get().code, label } })

  const applyEditorCommandInner = (cmd: EditorCommand): string => {
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
    if (cmd.kind === 'note') {
      const note = cmd.code.replace(/\s+/g, ' ').trim().slice(0, 160)
      if (!note) return ''
      set((s) => ({ notes: [...s.notes.filter((n) => n.toLowerCase() !== note.toLowerCase()), note].slice(-MAX_NOTES) }))
      return ` _(noted: ${note})_`
    }
    if (cmd.kind === 'run') {
      void get().runOrSubmit('run')
      return ' _(pressed Run)_'
    }
    if (cmd.kind === 'lines') {
      const nl = cmd.code.indexOf('\n')
      const head = nl < 0 ? cmd.code : cmd.code.slice(0, nl)
      const body = nl < 0 ? '' : cmd.code.slice(nl + 1)
      const m = head.match(/(\d+)\s*(?:-|–|to|,)?\s*(\d+)?/)
      if (!m) return ''
      const a = Number(m[1])
      const b = Number(m[2] ?? m[1])
      const before = get().code
      const range = replaceLines(a, b, fixFirstLineIndent(body, before.split('\n')[Math.min(a, b) - 1] ?? ''))
      if (!range) return ''
      markAiEdit(before, 'line edit')
      const span = range.startLine === range.endLine ? `line ${range.startLine}` : `lines ${range.startLine}–${range.endLine}`
      return body.trim() ? ` _(changed ${span})_` : ` _(deleted ${span})_`
    }
    if (cmd.kind === 'replace') {
      const { code, settings } = get()
      // A "rewrite" that drops most of a real file is almost always a model mistake (it put one line in REPLACE),
      // unless they asked to clear it. Never apply that silently.
      const drastic = nonEmptyLines(code) >= 6 && nonEmptyLines(cmd.code) < nonEmptyLines(code) * 0.5 && !wantsClearFile(lastUserTurn)
      if (settings.autoApplyEdits && !drastic) {
        const before = code
        if (!replaceAll(cmd.code)) set({ code: cmd.code })
        set({ diffVisible: false, proposedCode: '' })
        markAiEdit(before, 'rewrite')
        slog('convo', 'auto_apply', { chars: cmd.code.length, beforeChars: before.length })
        return ' _(rewrote the file — Undo or Ctrl+Z to go back)_'
      }
      if (drastic) slog('convo', 'replace_guarded', { newLines: nonEmptyLines(cmd.code), oldLines: nonEmptyLines(code), asked: lastUserTurn.slice(0, 200) }, 'warn')
      set({
        proposedCode: cmd.code,
        diffVisible: true,
        diffState: 'pending',
        activeChip: null,
        chipResult: { chipId: 'generate', title: 'Proposed in chat', summary: 'Review the diff in the editor.' }
      })
      return drastic
        ? ' _(proposed a rewrite that removes most of the file — check the diff before accepting)_'
        : ' _(proposed a rewrite — accept or reject it in the editor)_'
    }
    const beforeInsert = get().code
    const line = insertAtCursor(cmd.code)
    if (line !== null) markAiEdit(beforeInsert, 'insert')
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
      stream.notes += applyEditorCommand(commands[stream.executed], stream.requestId)
      stream.executed += 1
    }
    // "(silent)" may still be arriving: show and say nothing until it's clear it isn't.
    const maybeSilent = looksSilent(visible, true)
    if (visible.length > stream.visibleLen && !maybeSilent) {
      const fresh = visible.slice(stream.visibleLen)
      stream.visibleLen = visible.length
      if (stream.speak) {
        recentAgentSpeech.push({ text: fresh, at: Date.now() })
        speakSentences(stream.chunker.feed(fresh))
      }
    }
    setLastAssistant((maybeSilent ? '' : visible.trim()) + stream.notes)
  }

  const onChunk = (e: StreamChunkEvent): void => {
    if (!liveStream || e.requestId !== liveStream.requestId) return
    if (liveStream.firstChunkAt === null) liveStream.firstChunkAt = Date.now()
    liveStream.raw += e.delta
    ingest(liveStream)
  }

  const onDone = (e: StreamDoneEvent): void => {
    if (!liveStream || e.requestId !== liveStream.requestId) return
    const stream = liveStream
    liveStream = null
    const markers = Object.values(EDITOR_CMD).filter((m) => m !== EDITOR_CMD.end)
    const opened = markers.reduce((n, m) => n + stream.raw.split(m).length - 1, 0)
    if (!e.error && !e.cancelled && opened > splitEditorCommands(stream.raw).commands.length) {
      slog('convo', 'editor_cmd_malformed', { requestId: stream.requestId, opened, applied: stream.executed, tail: stream.raw.slice(-200) }, 'warn')
    }
    if (e.error) {
      setLastAssistant(splitEditorCommands(stream.raw).visible + `\n\nCopilot error: ${e.error}`)
      // A refusal from the brakes/budget/off-switch: stop listening so a voice loop can't keep retrying.
      if (/paused|budget|switched off/i.test(e.error)) {
        set({ pausedReason: e.error })
        if (get().voice.micOn) void get().toggleMic()
      }
    } else if (!e.cancelled) {
      ingest(stream)
      if (stream.speak && !looksSilent(splitEditorCommands(stream.raw).visible)) speakSentences(stream.chunker.flush())
    }
    const silent = !e.error && !e.cancelled && looksSilent(splitEditorCommands(stream.raw).visible)
    slog(
      'convo',
      e.error ? 'assistant_error' : 'assistant',
      {
        requestId: stream.requestId,
        silent: silent || undefined,
        text: (splitEditorCommands(stream.raw).visible.trim() + stream.notes).slice(0, 4000),
        error: e.error,
        cancelled: e.cancelled || undefined,
        spoken: stream.speak,
        ms: Date.now() - stream.startedAt,
        firstChunkMs: stream.firstChunkAt ? stream.firstChunkAt - stream.startedAt : undefined
      },
      e.error ? 'error' : 'info'
    )
    set((s) => {
      const messages = s.messages.slice()
      const last = messages[messages.length - 1]
      // Cancelled before a word, or a deliberate "(silent)": nothing to keep (any edit notes stay).
      if ((e.cancelled || silent) && last?.role === 'assistant' && !last.text.trim()) messages.pop()
      return { messages, chatSending: false }
    })
    const { currentPlaygroundId } = get()
    if (currentPlaygroundId) void persistCurrentPlayground(get, currentPlaygroundId)
  }

  const setVoice = (patch: Partial<VoiceUiState>): void => {
    if (patch.lastError) slog('voice', 'ui_error', { message: patch.lastError }, 'warn')
    set((s) => ({ voice: { ...s.voice, ...patch } }))
  }

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
          cancel('user_kept_talking')
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
        cancel('barge_in')
      },
      onFinal: (text) => {
        setVoice({ partial: '' })
        const overlap = echoOverlap(text)
        if (overlap >= ECHO_THRESHOLD) {
          // The mic heard the agent's own voice (speakers, no headphones). Never turn that into a paid turn.
          slog('convo', 'echo_dropped', { heard: text, overlap: Number(overlap.toFixed(2)) }, 'warn')
          setVoice({ lastError: `Ignored echo of the assistant: “${text.slice(0, 60)}…”` })
          return
        }
        let turn = text
        let merged = false
        if (pendingContinuation && Date.now() - pendingContinuation.at < CONTINUATION_WINDOW_MS) {
          turn = `${pendingContinuation.userText} ${text}`
          merged = true
          slog('convo', 'continuation_merged', { earlier: pendingContinuation.userText, heard: text, merged: turn })
        }
        pendingContinuation = null
        void get().sendMessage(turn, { speak: true, heard: merged ? text : undefined })
      },
      onPlaybackChange: (playing) => setVoice({ agentSpeaking: playing }),
      onError: (message) => setVoice({ lastError: message }),
      onClose: () => {
        voice = null
        setVoice({ micOn: false, agentSpeaking: false, connecting: false, micMuted: false, deafened: false })
      }
    })
    await client.connect(port)
    client.setVolume(get().settings.voiceVolume)
    const { micMuted, deafened } = get().voice
    client.setOutputMuted(deafened)
    client.setMicMuted(micMuted || deafened)
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
      // Apply instantly, persist once things settle: a slider drag or typing used to write the file per step.
      const next = { ...get().settings, ...patch }
      set({ settings: next })
      if (patch.voiceVolume !== undefined) voice?.setVolume(patch.voiceVolume)
      if (settingsSaveTimer) clearTimeout(settingsSaveTimer)
      settingsSaveTimer = setTimeout(() => {
        settingsSaveTimer = null
        void window.api.store.setSettings(get().settings)
      }, SETTINGS_SAVE_DEBOUNCE_MS)
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
      cancel('start_scratch')
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
        view: 'workspace',
        ...FRESH_SESSION
      })
    },
    resetCode: (variant) => {
      const { question, language } = get()
      set({ code: variant === 'template' ? templateFor(question, language) : starterFor(question, language), diffVisible: false, proposedCode: '' })
    },
    openQuestion: (id) => {
      const q = questionById(id)
      if (!q) return
      cancel('open_question')
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
        view: 'workspace',
        ...FRESH_SESSION
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

      const chipFailed = res.summary.startsWith('Copilot error')
      slog('convo', chipFailed ? 'chip_error' : 'chip', { chipId, summary: res.summary.slice(0, 1500), proposedChars: res.proposedCode?.length, diff: def.diff, selection: Boolean(snap?.selection) }, chipFailed ? 'error' : 'info')
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
      slog('convo', 'diff_accept', { chars: get().proposedCode.length })
      set((s) => ({ code: s.proposedCode, diffState: 'accepted', autosave: 'saving' }))
      setTimeout(() => set({ diffVisible: false, autosave: 'saved' }), 500)
    },
    rejectDiff: () => {
      slog('convo', 'diff_reject')
      set({ diffState: 'rejected' })
      setTimeout(() => set({ diffVisible: false }), 500)
    },

    messages: [greeting(QUESTIONS[0])],
    chatSending: false,
    sendMessage: async (text, opts = {}) => {
      const trimmed = text.trim()
      if (!trimmed) return
      cancel('superseded_by_new_turn') // a new turn always supersedes the previous reply (typed or spoken)
      set({ pausedReason: null })
      const source: 'voice' | 'typed' = opts.speak ? 'voice' : 'typed'
      slog('convo', 'user', { text: trimmed, source, ...(opts.heard ? { lastHeard: opts.heard } : {}) })
      if (opts.speak) lastSpoken = { text: trimmed, at: Date.now() }
      lastUserTurn = trimmed
      if (wantsSolution(trimmed) && !get().solutionUnlocked) {
        set({ solutionUnlocked: true })
        slog('convo', 'solution_unlocked', { text: trimmed })
      }

      // "shut up" / "um, wait" / "run it": answered here, no model call. The words stay in the thread as context.
      const intent = localIntent(trimmed)
      if (intent) {
        slog('convo', 'local_intent', { intent, text: trimmed })
        set((s) => ({
          messages: [
            ...s.messages,
            { role: 'user', text: trimmed, source },
            ...(intent === 'run' ? [{ role: 'assistant' as const, text: '_(pressed Run)_', source }] : [])
          ]
        }))
        if (intent === 'run') void get().runOrSubmit('run')
        return
      }

      // "ghost text one line", "ghost text comments only", "turn ghost text off": settings changed by voice, no model call.
      const ghost = parseGhostCommand(trimmed)
      if (ghost) {
        void get().updateSettings(ghost.patch)
        slog('convo', 'ghost_command', { text: trimmed, patch: ghost.patch })
        set((s) => ({
          messages: [...s.messages, { role: 'user', text: trimmed, source }, { role: 'assistant', text: ghost.reply, source }]
        }))
        if (opts.speak) void get().speakText(ghost.reply)
        return
      }

      // Navigation ("go to line 12", "highlight lines 3 to 7") is done locally first, so the model sees the
      // result; when that's all the message was, no model call is made at all.
      const nav = parseNavIntents(trimmed)
      if (!nav.actions.length && NAV_HINT.test(trimmed)) {
        slog('convo', 'nav_regex_miss', { text: trimmed, note: 'sounds like navigation but no pattern matched; sent to the model' }, 'warn')
      }
      if (nav.actions.length) {
        const notes = runNavActions(nav.actions)
        slog('convo', 'nav', { text: trimmed, actions: nav.actions, results: notes, navOnly: nav.navOnly, localReply: nav.navOnly ? notes.join(' ') : undefined })
        if (nav.navOnly) {
          const reply = notes.join(' ')
          set((s) => ({ messages: [...s.messages, { role: 'user', text: trimmed, source }, { role: 'assistant', text: reply, source }] }))
          if (opts.speak) void get().speakText(reply)
          return
        }
      }

      const { question, language, code, settings, messages, scratchNotes, notes, solutionUnlocked, lastRun } = get()
      // Read the caret/selection straight from Monaco (the store copy is throttled and could be 120 ms stale).
      const editorState = readEditorState() ?? get().editorState
      const history: ChatMessage[] = [...messages, { role: 'user', text: trimmed, source }]
      const requestId = uid()
      liveStream = { requestId, startedAt: Date.now(), firstChunkAt: null, speak: Boolean(opts.speak), chunker: new SentenceChunker(), raw: '', visibleLen: 0, executed: 0, notes: '' }
      set({ messages: [...history, { role: 'assistant', text: '', source }], chatSending: true })
      const recentChanges = codeAtLastTurn === null ? '' : describeChanges(codeAtLastTurn, code)
      codeAtLastTurn = code
      await window.api.ai.askStream({
        requestId,
        messages: history,
        guidedVoice: settings.helpStyle === 'guided',
        helpStyle: settings.helpStyle,
        solutionUnlocked,
        notes,
        lastRun,
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
    cancelReply: () => cancel('user_or_ui'),
    notes: [],
    removeNote: (index) => {
      slog('convo', 'note_removed', { note: get().notes[index] })
      set((s) => ({ notes: s.notes.filter((_, i) => i !== index) }))
    },
    solutionUnlocked: false,
    lastRun: '',
    lastAiEdit: null,
    undoAiEdit: () => {
      const edit = get().lastAiEdit
      if (!edit) return
      slog('convo', 'undo_ai_edit', { label: edit.label })
      if (!replaceAll(edit.before)) set({ code: edit.before })
      set({ lastAiEdit: null })
    },

    voice: {
      sidecar: { status: 'off', port: null },
      connecting: false,
      micOn: false,
      micMuted: false,
      deafened: false,
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
      slog('voice', 'mic_toggle', { to: v.micOn ? 'off' : 'on' })
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
    toggleMute: () => {
      const { voice: v } = get()
      if (v.deafened) return // undeafen first — deafening implies muted
      const next = !v.micMuted
      setVoice({ micMuted: next })
      voice?.setMicMuted(next)
    },
    toggleDeafen: () => {
      const { voice: v } = get()
      const next = !v.deafened
      setVoice({ deafened: next, ...(next ? { micMuted: true } : {}) })
      voice?.setOutputMuted(next)
      if (next) voice?.setMicMuted(true)
    },
    stopSpeaking: () => cancel('stop_button'),
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
      slog('cmd', 'run', { language, mode, ok: result.ok, exitCode: result.exitCode, timedOut: result.timedOut, ms: result.durationMs, stderr: result.stderr ? result.stderr.slice(0, 300) : undefined }, result.ok ? 'info' : 'warn')
      const summary = result.timedOut
        ? 'Timed out.'
        : result.ok
          ? `Exited 0 in ${result.durationMs}ms`
          : `Exited ${result.exitCode} in ${result.durationMs}ms`

      const lines: TerminalLine[] = []
      if (result.stdout) lines.push(...result.stdout.split('\n').map((text) => ({ text })))
      if (result.stderr) lines.push(...result.stderr.split('\n').map((text) => ({ text: `stderr: ${text}` })))
      lines.push({ text: summary })

      // The copilot sees this with the next turn (tail kept: the traceback's last lines matter most).
      const runText = [...lines.map((l) => l.text)].join('\n')
      set((s) => ({
        running: false,
        terminalLines: [...s.terminalLines.slice(0, -1), ...lines],
        lastRun: runText.length > 1500 ? '…' + runText.slice(-1500) : runText
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
      cancel('new_playground')
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
        view: 'workspace',
        ...FRESH_SESSION
      })
      await get().loadPlaygrounds()
    },
    openPlayground: async (id) => {
      const playground = await window.api.store.getPlayground(id)
      if (!playground) return
      cancel('open_playground')
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
        view: 'workspace',
        ...FRESH_SESSION
      })
    },

    init: async () => {
      if (!initialized) {
        initialized = true
        window.api.ai.onStreamChunk(onChunk)
        window.api.ai.onStreamDone(onDone)
        window.api.ai.onUsage(({ summary }) => set({ usage: summary }))
        window.api.ai.onPaused((reason) => {
          slog('convo', 'paused', { reason }, 'warn')
          set({ pausedReason: reason })
          cancel('brake')
          if (get().voice.micOn) void get().toggleMic()
        })
        void window.api.ai.usageSummary().then((usage) => set({ usage }))
        // Derived voice state, logged on every change with exactly which fields moved.
        const watched = (s: AppState): Record<string, unknown> => ({
          sidecar: s.voice.sidecar.status,
          connecting: s.voice.connecting,
          micOn: s.voice.micOn,
          micMuted: s.voice.micMuted,
          deafened: s.voice.deafened,
          userSpeaking: s.voice.userSpeaking,
          agentSpeaking: s.voice.agentSpeaking,
          chatSending: s.chatSending,
          paused: Boolean(s.pausedReason)
        })
        let prevSnap = watched(get())
        let prevState = deriveVoiceState(get())
        slog('voice', 'state', { state: prevState, reason: 'app start' })
        useAppStore.subscribe((s) => {
          const snap = watched(s)
          const changed = Object.keys(snap).filter((k) => snap[k] !== prevSnap[k])
          if (!changed.length) return // editor typing etc. also flows through here
          const state = deriveVoiceState(s)
          if (state !== prevState) {
            slog('voice', 'state', { state, prev: prevState, reason: changed.map((k) => `${k}=${String(snap[k])}`).join(', ') })
            prevState = state
          }
          prevSnap = snap
        })
        window.api.voice.onStateChanged((sidecar) => {
          setVoice({ sidecar, ...(sidecar.status !== 'ready' ? { micOn: false, agentSpeaking: false } : {}) })
          if (sidecar.status !== 'ready') {
            if (voice) slog('voice', 'client_closed_sidecar_down', { status: sidecar.status, message: sidecar.message }, sidecar.status === 'error' ? 'error' : 'info')
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
