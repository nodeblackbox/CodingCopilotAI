/**
 * Types shared across main, preload, and renderer.
 * Keep this file free of Node/DOM-only APIs so it can be imported from any of the three.
 */

export type AiProviderId = 'anthropic' | 'groq' | 'gemini'

export interface ProviderStatus {
  id: AiProviderId
  label: string
  configured: boolean
}

export type ChatRole = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  role: ChatRole
  text: string
  /** How the turn happened. Lets ghost text use only what was said out loud ("voice" context mode). */
  source?: 'voice' | 'typed'
  /** Assistant reply the user talked over: the part they actually heard before cutting in. */
  heard?: string
}

/**
 * coach  = explains and hints; types only what you ask for; never the solution until you say "I give up".
 * guided = one small step at a time, then waits.
 * pair   = does what you ask, including writing code, but doesn't volunteer the answer.
 * listen = in the background: hears everything, answers only direct questions or commands.
 */
export type HelpStyle = 'coach' | 'guided' | 'pair' | 'listen'

export const HELP_STYLES: ReadonlyArray<{ id: HelpStyle; label: string; hint: string }> = [
  { id: 'coach', label: 'Coach', hint: 'Hints and explanations. Types only what you ask for. No full solution until you say "I give up".' },
  { id: 'guided', label: 'Guided', hint: 'One small step at a time, then waits for you.' },
  { id: 'pair', label: 'Pair', hint: 'Does what you ask, including writing the code — but never volunteers the answer.' },
  { id: 'listen', label: 'Listen', hint: 'Stays in the background. Hears everything, only answers direct questions or commands.' }
]

export type ChipId =
  | 'explain'
  | 'hints'
  | 'ideaMap'
  | 'generate'
  | 'addTests'
  | 'lint'
  | 'complete'
  | 'optimize'
  | 'checkLogic'
  | 'related'

/** Chips whose result is a full replacement for the buffer, rendered as a diff. */
export const DIFF_CHIPS: ReadonlySet<ChipId> = new Set(['generate', 'complete', 'optimize'])

export interface ChipRequest {
  chipId: ChipId
  questionTitle: string
  questionPrompt: string
  language: string
  code: string
}

export interface ChipResponse {
  chipId: ChipId
  /** Prose explanation shown in the copilot panel. */
  summary: string
  /** Present only for chips in DIFF_CHIPS: the full proposed replacement source. */
  proposedCode?: string
}

export interface CursorInfo {
  line: number
  column: number
}

export interface SelectionRange {
  startLine: number
  endLine: number
}

/** A pseudo-question for free coding: no problem statement, the user says what they're working on. */
export const SCRATCH_QUESTION_ID = 'scratch'

export interface AskRequest {
  messages: ChatMessage[]
  guidedVoice: boolean
  /** True when the reply will be spoken aloud: the prompt asks for short, speakable answers. */
  spoken?: boolean
  questionTitle: string
  questionPrompt: string
  language: string
  code: string
  /** Where the caret is in the editor, so "what line am I on" and "insert here" mean something. */
  cursor?: CursorInfo
  /** Currently selected text, if any. */
  selection?: string
  /** Line span of that selection, so the listing can mark it. */
  selectionRange?: SelectionRange
  /** Unified-style +/- lines describing what the user changed since the assistant's previous reply. */
  recentChanges?: string
  /** 'scratch' = free coding with no assigned problem; questionPrompt then holds the user's own notes. */
  mode?: 'interview' | 'scratch'
  helpStyle?: HelpStyle
  /** The user explicitly asked for the answer ("I give up") in this session. */
  solutionUnlocked?: boolean
  /** Standing instructions/facts for this session ("doing brute force first"), kept beyond the history window. */
  notes?: string[]
  /** Output of the most recent Run, so "what does it print?" and tracebacks don't need pasting. */
  lastRun?: string
}

/**
 * Editor command protocol. The model wraps code it wants typed into the editor in these markers; the
 * renderer strips them from the displayed/spoken reply and applies them (INSERT at the cursor, REPLACE
 * through the Accept/Reject diff). Shared so the prompt and the parser can never disagree.
 */
export const EDITOR_CMD = {
  insert: '<<<INSERT>>>',
  replace: '<<<REPLACE>>>',
  /** Body: a line number. Moves the caret there and scrolls it into view. */
  goto: '<<<GOTO>>>',
  /** Body: "A-B" (or a single line). Highlights those lines; they become the selection for the next turn. */
  select: '<<<SELECT>>>',
  /** Body: "A-B" (or one line) on the first line, then the replacement text. Empty replacement deletes the lines. */
  lines: '<<<LINES>>>',
  /** Empty body. Presses Run; the output arrives with the next turn. */
  run: '<<<RUN>>>',
  /** Body: one short standing fact or preference to remember for the rest of the session. */
  note: '<<<NOTE>>>',
  end: '<<<END>>>'
} as const

/** A reply meaning "nothing to say" (listen style, filler): the renderer neither shows nor speaks it. */
export const SILENT_REPLY = '(silent)'

export interface AskResponse {
  text: string
}

/** Streaming chat: the renderer supplies the requestId so it can correlate chunk events + cancel. */
export interface AskStreamRequest extends AskRequest {
  requestId: string
}

export interface StreamChunkEvent {
  requestId: string
  delta: string
}

export interface StreamDoneEvent {
  requestId: string
  text: string
  error?: string
  cancelled?: boolean
}

/** Copilot-style ghost text: continue the code at the cursor. */
export interface InlineCompleteRequest {
  language: string
  prefix: string
  suffix: string
  questionTitle: string
  /** Recent chat/voice exchange, so the suggestion follows what the user is actually working toward. */
  conversation?: string
  /** What the user last SAID out loud (within ~2 min) — the strongest steer for what to write next. */
  spokenIntent?: string
  /** Letters already typed of the word under the cursor, when the renderer wants spelling help. */
  partialWord?: string
}

/** How much a ghost-text suggestion may contain (see src/shared/inline.ts). */
export type InlineScope = 'word' | 'phrase' | 'line' | 'lines' | 'block'
/** Which conversation feeds ghost text: nothing, only what was spoken, or everything in the thread. */
export type InlineChatContext = 'off' | 'voice' | 'all'
export type InlineTrigger = 'auto' | 'manual'

export interface InlineCompleteResponse {
  text: string
}

export interface RunRequest {
  code: string
  language: string
  stdin?: string
}

export interface RunResult {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number | null
  durationMs: number
  timedOut: boolean
}

/**
 * webspeech = the OS voices via the browser's speechSynthesis (instant, offline, runs in the renderer);
 * edge = Microsoft Edge neural voices through the Python sidecar (network, ~3 s/sentence);
 * kokoro = local Kokoro-82M through the sidecar (GPU).
 */
export type TtsEngine = 'webspeech' | 'edge' | 'kokoro'

/** Anthropic model ids the UI offers. Haiku is the default because voice turns are frequent and cheap should be cheap. */
export const ANTHROPIC_MODELS = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-5'
} as const

/** Hard limits that protect the API balance. */
export const COST_LIMITS = {
  /** Messages of history sent with a turn (older ones are dropped, not summarised). */
  historyMessages: 16,
  /** Editor text beyond this is cut from the prompt (head + tail kept). */
  maxCodeChars: 12_000,
  /** More chat turns than this within 60 s trips the brake: calls refused, mic switched off. */
  maxTurnsPerMinute: 8
} as const

/** One provider call, as recorded by main for the spend meter. Token counts come from the API when it reports them. */
export interface UsageEvent {
  at: number
  provider: AiProviderId
  model: string
  kind: 'chat' | 'chip' | 'inline'
  inputTokens: number
  outputTokens: number
  /** True when the provider didn't report usage and tokens were estimated from text length. */
  estimated: boolean
  costUsd: number
}

export interface UsageSummary {
  /** This app session. */
  calls: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  sessionStart: number
  /** Today (local date), including earlier sessions read back from usage.jsonl. */
  todayCostUsd: number
  todayCalls: number
}

export interface Settings {
  provider: AiProviderId
  /** Master switch: when false no provider is ever called (chat, chips, ghost text all return a notice). */
  aiEnabled: boolean
  /** Anthropic model for chat/chips. */
  chatModel: string
  /** When today's estimated spend (all providers, from usage.jsonl) reaches this, every call is refused until raised. */
  dailyBudgetUsd: number
  language: string
  guidedVoice: boolean
  /** Copilot-style inline completions in the editor. */
  inlineCompletions: boolean
  /** How much one suggestion may contain: a word, a phrase, a line, a few lines, or a block. */
  inlineScope: InlineScope
  /** Line cap for the "few lines" scope. */
  inlineMaxLines: number
  /** Suggest while writing code. */
  inlineInCode: boolean
  /** Suggest while writing comments / docstrings (plain-English prose). */
  inlineInComments: boolean
  /** auto = as you type; manual = only when you press Alt+\ . */
  inlineTrigger: InlineTrigger
  /** Pause after your last keystroke before asking, in ms. */
  inlineDebounceMs: number
  /** Conversation used to steer suggestions: none, only spoken turns, or the whole thread. */
  inlineChatContext: InlineChatContext
  /** In comments, fix a half-typed or misspelled word (recie → receive). */
  inlineSpellAssist: boolean
  /** Ghost text look: opacity 0.15–1, preset colour id (see GHOST_COLORS), italic. */
  ghostOpacity: number
  ghostColor: string
  ghostItalic: boolean
  /** How the copilot helps (see HELP_STYLES). Replaces the old guidedVoice switch, which maps to 'guided'. */
  helpStyle: HelpStyle
  /** Whole-file rewrites the user asked for land straight in the editor (Ctrl+Z / Undo) instead of waiting in a diff. */
  autoApplyEdits: boolean
  ttsEngine: TtsEngine
  /** Edge TTS voice name (e.g. en-US-AvaNeural), a Kokoro voice (af_heart), or a partial speechSynthesis voice name ("Ava"). */
  voiceName: string
  /** Playback volume for the assistant's voice, 0–1. */
  voiceVolume: number
  shortcuts: Record<string, string>
}

export interface PlaygroundFile {
  name: string
  language: string
  content: string
}

export interface Playground {
  id: string
  title: string
  questionId: string | null
  files: PlaygroundFile[]
  activeFile: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
}

export interface QuestionExample {
  heading: string
  lines: string[]
}

export interface Question {
  id: string
  title: string
  index: number
  category: string
  difficulty: 'Easy' | 'Medium' | 'Hard'
  topics: string[]
  prompt: string
  examples: QuestionExample[]
  constraints: string[]
  starterCode: Record<string, string>
  /** Signature-only version of starterCode (no solution attempt), when the starter contains one. */
  templateCode?: Record<string, string>
  status: 'solved' | 'attempted' | 'not_started'
}

/** Python voice sidecar lifecycle, as seen from the renderer. */
export type VoiceStatus = 'off' | 'starting' | 'ready' | 'error'

export interface VoiceSidecarState {
  status: VoiceStatus
  port: number | null
  message?: string
}

/** IPC channel names, centralized so main/preload/renderer never typo a string literal. */
export const IPC = {
  aiAsk: 'ai:ask',
  aiAskStream: 'ai:askStream',
  aiStreamChunk: 'ai:stream:chunk',
  aiStreamDone: 'ai:stream:done',
  aiStreamCancel: 'ai:stream:cancel',
  aiChip: 'ai:chip',
  aiInlineComplete: 'ai:inlineComplete',
  aiProviderStatus: 'ai:providerStatus',
  aiUsage: 'ai:usage',
  aiUsageSummary: 'ai:usageSummary',
  /** Main → renderer: the rate brake tripped; payload is a human-readable reason. */
  aiPaused: 'ai:paused',
  runCode: 'run:code',
  storeGetSettings: 'store:getSettings',
  storeSetSettings: 'store:setSettings',
  storeListPlaygrounds: 'store:listPlaygrounds',
  storeGetPlayground: 'store:getPlayground',
  storeSavePlayground: 'store:savePlayground',
  storeDeletePlayground: 'store:deletePlayground',
  voiceStart: 'voice:start',
  voiceStop: 'voice:stop',
  voiceStatus: 'voice:status',
  voiceStateChanged: 'voice:stateChanged',
  debugOpenDevtools: 'debug:openDevtools',
  debugGetLogPath: 'debug:getLogPath',
  /** Renderer → main (fire-and-forget): append a batch of events to the per-run session log. */
  logEvents: 'log:events',
  debugOpenLogsDir: 'debug:openLogsDir',
  debugSessionInfo: 'debug:sessionInfo'
} as const

/** One renderer-originated session-log event (see src/main/services/sessionLog.ts). */
export interface LogEventInput {
  cat: string
  ev: string
  data?: unknown
  level?: 'debug' | 'info' | 'warn' | 'error'
}

export interface SessionInfo {
  sessionId: string
  file: string
  conversationFile: string
  dir: string
  bytes: number
}
