import { app } from 'electron'
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Per-run structured logs. Two JSONL files per launch, same id:
 *
 *   <userData>/logs/sessions/<id>.jsonl        technical timeline: voice states, STT/TTS, sidecar, errors, settings
 *   <userData>/logs/conversations/<id>.jsonl   the conversation: what you said, what the assistant said, commands
 *
 * Record shape: { t, seq, ms (since launch), cat, ev, level?, data? }. Main-process code, the renderer (via IPC)
 * and the voice sidecar all append here. Read them through `npm run logs` (scripts/logs.mjs) rather than raw:
 * start with the conversation when a reply "felt wrong", with the session when something broke.
 */

export type SessionLevel = 'debug' | 'info' | 'warn' | 'error'

const KEEP_SESSIONS = 30
const FLUSH_MS = 150
const MAX_STRING = 4000

interface Channel {
  dir: () => string
  file: string
  seq: number
  buffer: string[]
  timer: NodeJS.Timeout | null
}

const logsRoot = (): string => join(app.getPath('userData'), 'logs')
const session: Channel = { dir: () => join(logsRoot(), 'sessions'), file: '', seq: 0, buffer: [], timer: null }
const convo: Channel = { dir: () => join(logsRoot(), 'conversations'), file: '', seq: 0, buffer: [], timer: null }

let sessionId = ''
let startedAt = 0

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function sessionsDir(): string {
  return session.dir()
}

export function conversationsDir(): string {
  return convo.dir()
}

/** JSON.stringify replacer: real Error stacks (plain stringify yields `{}`), bigint, runaway strings. */
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string' && value.length > MAX_STRING) {
    return `${value.slice(0, MAX_STRING)}…[+${value.length - MAX_STRING} chars]`
  }
  return value
}

export function serialize(value: unknown): string {
  try {
    return JSON.stringify(value, replacer)
  } catch {
    return JSON.stringify({ unserializable: String(value) })
  }
}

function pruneOld(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort() // names start with a timestamp, so lexical == chronological
    for (const f of files.slice(0, Math.max(0, files.length - (KEEP_SESSIONS - 1)))) {
      rmSync(join(dir, f), { force: true })
    }
  } catch {
    // best effort
  }
}

function flush(ch: Channel): void {
  if (ch.timer) {
    clearTimeout(ch.timer)
    ch.timer = null
  }
  if (!ch.file || ch.buffer.length === 0) return
  const chunk = ch.buffer.join('')
  ch.buffer = []
  try {
    appendFileSync(ch.file, chunk, 'utf8')
  } catch {
    // Logging must never crash the app.
  }
}

function append(ch: Channel, cat: string, ev: string, data: unknown, level: SessionLevel): void {
  if (!ch.file) return // not initialised yet (very early startup)
  const rec = {
    t: new Date().toISOString(),
    seq: ch.seq++,
    ms: Date.now() - startedAt,
    cat,
    ev,
    ...(level !== 'info' ? { level } : {}),
    ...(data !== undefined ? { data } : {})
  }
  ch.buffer.push(serialize(rec) + '\n')
  if (level === 'error') flush(ch) // make sure the line before a crash survives
  else if (!ch.timer) ch.timer = setTimeout(() => flush(ch), FLUSH_MS)
}

/** Call once, after app ready. Creates this run's files and writes the session_start record. */
export function initSessionLog(info: Record<string, unknown>): string {
  if (session.file) return session.file
  const d = new Date()
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  sessionId = `${stamp}_${Math.random().toString(36).slice(2, 6)}`
  for (const ch of [session, convo]) {
    mkdirSync(ch.dir(), { recursive: true })
    pruneOld(ch.dir())
    ch.file = join(ch.dir(), `${sessionId}.jsonl`)
  }
  startedAt = Date.now()
  sessionLog('app', 'session_start', {
    sessionId,
    pid: process.pid,
    platform: process.platform,
    electron: process.versions.electron,
    app: app.getVersion(),
    conversationFile: convo.file,
    ...info
  })
  return session.file
}

export function flushSessionLog(): void {
  flush(session)
  flush(convo)
}

/** Technical event (voice state, STT/TTS timing, sidecar, errors, settings…). */
export function sessionLog(cat: string, ev: string, data?: unknown, level: SessionLevel = 'info'): void {
  append(session, cat, ev, data, level)
}

/** Conversation event (user / assistant text, commands run, barge-ins). Keep these human-readable. */
export function convoLog(ev: string, data?: unknown, level: SessionLevel = 'info'): void {
  append(convo, 'convo', ev, data, level)
}

export function getSessionFile(): string {
  return session.file
}

export function getConversationFile(): string {
  return convo.file
}

export function getSessionId(): string {
  return sessionId
}

/** Size of the current session file, for diagnostics UI. */
export function sessionFileSize(): number {
  try {
    return statSync(session.file).size
  } catch {
    return 0
  }
}
