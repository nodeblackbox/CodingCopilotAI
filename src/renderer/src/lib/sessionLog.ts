import type { LogEventInput } from '@shared/types'

/**
 * Renderer-side handle on the per-run session log (main/services/sessionLog.ts).
 * Events are batched for a few ms and sent fire-and-forget so logging can never stall audio or typing.
 */

const FLUSH_MS = 60
let queue: LogEventInput[] = []
let timer: ReturnType<typeof setTimeout> | null = null

function flush(): void {
  timer = null
  if (queue.length === 0) return
  const batch = queue
  queue = []
  try {
    window.api?.debug?.logEvents(batch)
  } catch {
    // never let logging break the UI
  }
}

export function slog(cat: string, ev: string, data?: unknown, level: LogEventInput['level'] = 'info'): void {
  queue.push({ cat, ev, data, level })
  if (level === 'error') flush()
  else if (!timer) timer = setTimeout(flush, FLUSH_MS)
}

function errInfo(e: unknown): Record<string, unknown> {
  if (e instanceof Error) return { name: e.name, message: e.message, stack: e.stack }
  return { value: typeof e === 'string' ? e : safeString(e) }
}

function safeString(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export function logError(ev: string, e: unknown, extra?: Record<string, unknown>): void {
  slog('error', ev, { ...errInfo(e), ...extra }, 'error')
}

let installed = false

/** Capture everything that would otherwise vanish into DevTools. Safe to call more than once. */
export function installGlobalErrorLogging(): void {
  if (installed) return
  installed = true
  window.addEventListener('error', (e) => {
    logError('window_error', e.error ?? e.message, { file: e.filename, line: e.lineno, col: e.colno })
  })
  window.addEventListener('unhandledrejection', (e) => logError('unhandled_rejection', e.reason))
  window.addEventListener('beforeunload', () => {
    slog('app', 'renderer_unload')
    flush()
  })
  slog('app', 'renderer_ready', { ua: navigator.userAgent, w: window.innerWidth, h: window.innerHeight })
}
