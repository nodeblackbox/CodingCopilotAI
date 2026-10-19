import { app } from 'electron'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { serialize, sessionLog } from './services/sessionLog'

/**
 * Minimal structured logger for the main process.
 * Writes to <userData>/logs/main.log AND stdout, so `npm run debug`
 * (which also opens devtools + --inspect) has both a persisted trail
 * and live console output to watch. Warnings/errors (and notable info) are mirrored into the
 * per-run session log (services/sessionLog.ts), which is the file to hand over when debugging.
 */

type Level = 'debug' | 'info' | 'warn' | 'error'

const MAX_LOG_BYTES = 5 * 1024 * 1024

let logDir = ''
let logFile = ''
let ready = false

function ensureReady(): void {
  if (ready) return
  logDir = join(app.getPath('userData'), 'logs')
  logFile = join(logDir, 'main.log')
  mkdirSync(logDir, { recursive: true })
  // Rotate once per launch: keep one previous generation so the file can't grow forever.
  try {
    if (statSync(logFile).size > MAX_LOG_BYTES) renameSync(logFile, logFile + '.1')
  } catch {
    // no log yet, or rotation raced — fine
  }
  ready = true
}

/** Info lines that are pure noise in the session file (still kept in main.log). */
function mirrorsToSession(level: Level, scope: string, message: string): boolean {
  if (level === 'debug') return false
  if (level === 'info') {
    if (scope === 'store' || scope === 'voice:py') return false // voice:py is parsed by the sidecar service
    if (scope === 'usage' && message.startsWith('inline ')) return false // one per ghost-text call
  }
  return true
}

function write(level: Level, scope: string, message: string, meta?: unknown): void {
  ensureReady()
  const line = {
    t: new Date().toISOString(),
    level,
    scope,
    message,
    ...(meta !== undefined ? { meta } : {})
  }
  const serialized = serialize(line)
  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  consoleFn(`[${scope}] ${message}`, meta ?? '')
  try {
    appendFileSync(logFile, serialized + '\n', 'utf8')
  } catch {
    // Logging must never crash the app.
  }
  if (mirrorsToSession(level, scope, message)) sessionLog('log', scope, { message, meta }, level)
}

export const logger = {
  debug: (scope: string, message: string, meta?: unknown) => write('debug', scope, message, meta),
  info: (scope: string, message: string, meta?: unknown) => write('info', scope, message, meta),
  warn: (scope: string, message: string, meta?: unknown) => write('warn', scope, message, meta),
  error: (scope: string, message: string, meta?: unknown) => write('error', scope, message, meta),
  getLogPath: () => {
    ensureReady()
    return logFile
  }
}
