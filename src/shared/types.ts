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
}

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
}

/**
 * Editor command protocol. The model wraps code it wants typed into the editor in these markers; the
 * renderer strips them from the displayed/spoken reply and applies them (INSERT at the cursor, REPLACE
 * through the Accept/Reject diff). Shared so the prompt and the parser can never disagree.
 */
export const EDITOR_CMD = {
  insert: '<<<INSERT>>>',
  replace: '<<<REPLACE>>>',
  end: '<<<END>>>'
} as const

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
}

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

export interface Settings {
  provider: AiProviderId
  language: string
  guidedVoice: boolean
  /** Copilot-style inline completions in the editor. */
  inlineCompletions: boolean
  ttsEngine: TtsEngine
  /** Edge TTS voice name (e.g. en-US-AvaNeural), a Kokoro voice (af_heart), or a partial speechSynthesis voice name ("Ava"). */
  voiceName: string
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
  debugGetLogPath: 'debug:getLogPath'
} as const
