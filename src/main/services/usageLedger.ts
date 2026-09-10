import { app, BrowserWindow } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '@shared/types'
import type { AiProviderId, UsageEvent, UsageSummary } from '@shared/types'
import { logger } from '@main/logger'

/**
 * Spend meter. Every provider call is recorded with the token counts the API reported (or a length-based
 * estimate when it didn't), priced, appended to <userData>/usage.jsonl and pushed to the renderer.
 * Today's total is read back from the file at startup so the daily budget survives restarts.
 * Prices are list prices per million tokens as of 2026-09; they are estimates, not an invoice.
 */

const PRICE_PER_M: Record<string, { input: number; output: number }> = {
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'openai/gpt-oss-120b': { input: 0.15, output: 0.6 },
  'gemini-flash-latest': { input: 0.3, output: 2.5 }
}

const summary: UsageSummary = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  sessionStart: Date.now(),
  todayCostUsd: 0,
  todayCalls: 0
}
let loadedToday = false

function ledgerPath(): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'usage.jsonl')
}

const dayKey = (t: number): string => new Date(t).toDateString()

/** Sum today's earlier sessions once, so "today" in the UI and the budget check mean the whole day. */
function ensureTodayLoaded(): void {
  if (loadedToday) return
  loadedToday = true
  const path = ledgerPath()
  if (!existsSync(path)) return
  const today = dayKey(Date.now())
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as UsageEvent
      if (dayKey(e.at) === today) {
        summary.todayCostUsd += e.costUsd
        summary.todayCalls += 1
      }
    } catch {
      /* skip a corrupt line */
    }
  }
  if (summary.todayCalls) logger.info('usage', `Earlier today: ${summary.todayCalls} calls ≈ $${summary.todayCostUsd.toFixed(3)}`)
}

export function priceFor(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICE_PER_M[model] ?? { input: 3, output: 15 } // unknown model: assume Sonnet-class so we never under-report
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000
}

/** ~4 chars per token; used only when a provider doesn't return usage. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

export function recordUsage(e: Omit<UsageEvent, 'at' | 'costUsd'>): UsageEvent {
  ensureTodayLoaded()
  const event: UsageEvent = { ...e, at: Date.now(), costUsd: priceFor(e.model, e.inputTokens, e.outputTokens) }
  summary.calls += 1
  summary.inputTokens += event.inputTokens
  summary.outputTokens += event.outputTokens
  summary.costUsd += event.costUsd
  summary.todayCostUsd += event.costUsd
  summary.todayCalls += 1
  try {
    appendFileSync(ledgerPath(), JSON.stringify(event) + '\n', 'utf8')
  } catch (err) {
    logger.warn('usage', 'Could not append to usage.jsonl', (err as Error).message)
  }
  logger.info(
    'usage',
    `${e.kind} ${e.provider}/${e.model} in=${e.inputTokens} out=${e.outputTokens}${e.estimated ? ' (est)' : ''} ≈ $${event.costUsd.toFixed(4)} · today ≈ $${summary.todayCostUsd.toFixed(3)} over ${summary.todayCalls} calls`
  )
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.aiUsage, { event, summary: getUsageSummary() })
  }
  return event
}

export function getUsageSummary(): UsageSummary {
  ensureTodayLoaded()
  return { ...summary }
}

export type { AiProviderId }
