import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Minimal structured logger for the main process.
 * Writes to <userData>/logs/main.log AND stdout, so `npm run debug`
 * (which also opens devtools + --inspect) has both a persisted trail
 * and live console output to watch.
 */

type Level = 'debug' | 'info' | 'warn' | 'error'

let logDir = ''
let logFile = ''
let ready = false

function ensureReady(): void {
  if (ready) return
  logDir = join(app.getPath('userData'), 'logs')
  logFile = join(logDir, 'main.log')
  mkdirSync(logDir, { recursive: true })
  ready = true
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
  const serialized = JSON.stringify(line)
  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  consoleFn(`[${scope}] ${message}`, meta ?? '')
  try {
    appendFileSync(logFile, serialized + '\n', 'utf8')
  } catch {
    // Logging must never crash the app.
  }
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
