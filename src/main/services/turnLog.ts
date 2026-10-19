import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AskRequest, CursorInfo } from '@shared/types'
import { logger } from '@main/logger'
import { sessionLog } from '@main/services/sessionLog'

/**
 * One JSON line per chat/voice turn in <userData>/turns.jsonl: exactly what the model was shown (code
 * snapshot, cursor, diff since last turn, trimmed history) and what came back. This is the record to
 * replay when a reply seems to ignore the editor — you can see whether the change was in the prompt.
 */
export interface TurnRecord {
  at: number
  requestId: string
  provider: string
  model: string
  spoken: boolean
  guided: boolean
  helpStyle?: string
  solutionUnlocked?: boolean
  notes?: string[]
  lastRun?: string
  cursor?: CursorInfo
  selection?: string
  recentChanges?: string
  codeChars: number
  code: string
  historyCount: number
  history: Array<{ role: string; text: string }>
  reply: string
  error?: string
  cancelled?: boolean
  ms: number
}

function path(): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'turns.jsonl')
}

export function logTurn(
  req: AskRequest & { requestId: string },
  meta: { provider: string; model: string; startedAt: number },
  outcome: { reply: string; error?: string; cancelled?: boolean }
): void {
  const rec: TurnRecord = {
    at: Date.now(),
    requestId: req.requestId,
    provider: meta.provider,
    model: meta.model,
    spoken: Boolean(req.spoken),
    guided: req.guidedVoice,
    helpStyle: req.helpStyle,
    solutionUnlocked: req.solutionUnlocked || undefined,
    notes: req.notes?.length ? req.notes : undefined,
    lastRun: req.lastRun || undefined,
    cursor: req.cursor,
    selection: req.selection || undefined,
    recentChanges: req.recentChanges || undefined,
    codeChars: req.code.length,
    code: req.code,
    historyCount: req.messages.length,
    history: req.messages.map((m) => ({ role: m.role, text: m.text })),
    reply: outcome.reply,
    error: outcome.error,
    cancelled: outcome.cancelled,
    ms: Date.now() - meta.startedAt
  }
  // Compact pointer into the session timeline; the full prompt (code snapshot, history) stays in turns.jsonl.
  sessionLog(
    'ai',
    'turn',
    {
      requestId: rec.requestId,
      provider: rec.provider,
      model: rec.model,
      spoken: rec.spoken,
      helpStyle: rec.helpStyle,
      solutionUnlocked: rec.solutionUnlocked,
      notes: rec.notes?.length,
      hasRunOutput: Boolean(rec.lastRun),
      ms: rec.ms,
      codeChars: rec.codeChars,
      historyCount: rec.historyCount,
      cursor: rec.cursor,
      hasSelection: Boolean(rec.selection),
      hadChangesDiff: Boolean(rec.recentChanges),
      replyChars: rec.reply.length,
      error: rec.error,
      cancelled: rec.cancelled
    },
    rec.error ? 'error' : 'info'
  )
  try {
    appendFileSync(path(), JSON.stringify(rec) + '\n', 'utf8')
  } catch (err) {
    logger.warn('turnLog', 'Could not append to turns.jsonl', (err as Error).message)
  }
}

export function turnLogPath(): string {
  return path()
}
