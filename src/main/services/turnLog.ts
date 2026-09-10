import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AskRequest, CursorInfo } from '@shared/types'
import { logger } from '@main/logger'

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
  try {
    appendFileSync(path(), JSON.stringify(rec) + '\n', 'utf8')
  } catch (err) {
    logger.warn('turnLog', 'Could not append to turns.jsonl', (err as Error).message)
  }
}

export function turnLogPath(): string {
  return path()
}
