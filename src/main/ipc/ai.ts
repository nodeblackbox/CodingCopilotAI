import { ipcMain, BrowserWindow } from 'electron'
import { IPC, DIFF_CHIPS, COST_LIMITS } from '@shared/types'
import type {
  AskRequest,
  AskResponse,
  AskStreamRequest,
  ChatMessage,
  ChipRequest,
  ChipResponse,
  InlineCompleteRequest,
  InlineCompleteResponse,
  Settings,
  StreamChunkEvent,
  StreamDoneEvent
} from '@shared/types'
import { getProvider, resolveProvider, listProviderStatus } from '@main/services/aiProviders'
import type { AiProvider, TokenUsage } from '@main/services/aiProviders/types'
import { buildAskSystemPrompt, buildChipPrompt, buildInlinePrompt } from '@main/services/prompts'
import { getSettings } from '@main/services/store'
import { inlineContextKind, inlineMaxTokens, limitInline, restoreFlattenedNewlines } from '@shared/inline'
import { estimateTokens, getUsageSummary, recordUsage } from '@main/services/usageLedger'
import { logTurn } from '@main/services/turnLog'
import { logger } from '@main/logger'

/** In-flight streams by requestId, so the renderer can cancel (barge-in, new message). */
const activeStreams = new Map<string, AbortController>()

/** Inline completions: only the newest request matters; abort the previous one on arrival. */
let inlineAbort: AbortController | null = null

/** Timestamps of recent chat turns, for the runaway brake. */
const recentTurns: number[] = []

const isAbort = (err: unknown): boolean => (err as Error)?.name === 'AbortError'

class AiDisabledError extends Error {}

function assertEnabled(settings: Settings): void {
  if (!settings.aiEnabled) {
    logger.warn('ai:refused', 'AI is switched off')
    throw new AiDisabledError('AI calls are switched off (toggle "AI on" in the copilot header).')
  }
  const today = getUsageSummary().todayCostUsd
  if (settings.dailyBudgetUsd > 0 && today >= settings.dailyBudgetUsd) {
    logger.warn('ai:refused', `Daily budget reached (${today.toFixed(3)} of ${settings.dailyBudgetUsd})`)
    throw new AiDisabledError(
      `Daily budget reached (≈$${today.toFixed(2)} of $${settings.dailyBudgetUsd.toFixed(2)} today). Raise it in Settings if you mean to keep going.`
    )
  }
}

/**
 * The brake against self-talk loops (mic hears the agent → transcribes it → new turn → …) and any other
 * runaway. Trips when more than COST_LIMITS.maxTurnsPerMinute chat turns start within 60 s.
 */
function checkTurnRate(sender: Electron.WebContents): void {
  const now = Date.now()
  while (recentTurns.length && now - recentTurns[0] > 60_000) recentTurns.shift()
  if (recentTurns.length >= COST_LIMITS.maxTurnsPerMinute) {
    const reason = `${recentTurns.length} chat turns in the last minute — paused to protect your API balance. Turn the mic back on when you're ready.`
    logger.warn('ai:brake', reason)
    if (!sender.isDestroyed()) sender.send(IPC.aiPaused, reason)
    throw new AiDisabledError(reason)
  }
  recentTurns.push(now)
}

/**
 * Keep the prompt bounded and well-formed: last N messages, editor text head+tail, and strictly
 * alternating roles — a cancelled/empty assistant turn otherwise leaves two user messages in a row,
 * which Anthropic rejects ("roles must alternate") and the user sees as "it broke".
 */
function trimForPrompt<T extends AskRequest>(req: T): T {
  const merged: ChatMessage[] = []
  for (const m of req.messages) {
    if (m.role === 'system' || !m.text.trim()) continue
    // A reply the user talked over: the model should know they only heard the first part.
    // Edits it made ("_(typed 2 lines at line 7)_") still happened, so they stay.
    const text =
      m.role === 'assistant' && m.heard !== undefined
        ? [`${m.heard.trim() || '(nothing)'} [cut off — they did not hear the rest]`, ...(m.text.match(/_\([^)]*\)_/g) ?? [])].join(' ')
        : m.text
    const last = merged[merged.length - 1]
    if (last && last.role === m.role) last.text = `${last.text}\n\n${text}`
    else merged.push({ role: m.role, text })
  }
  const messages = merged.slice(-COST_LIMITS.historyMessages)
  // Anthropic requires the first message to be from the user, and the last one must be the new user turn.
  while (messages.length && messages[0].role !== 'user') messages.shift()
  while (messages.length > 1 && messages[messages.length - 1].role !== 'user') messages.pop()
  let code = req.code
  if (code.length > COST_LIMITS.maxCodeChars) {
    const half = Math.floor(COST_LIMITS.maxCodeChars / 2)
    code = `${code.slice(0, half)}\n# … ${code.length - COST_LIMITS.maxCodeChars} characters omitted …\n${code.slice(-half)}`
  }
  return { ...req, messages, code }
}

function usageRecorder(
  provider: AiProvider,
  model: string,
  kind: 'chat' | 'chip' | 'inline',
  promptText: () => string
): { onUsage: (u: TokenUsage) => void; finish: (outputText: string) => void } {
  let reported = false
  return {
    onUsage: (u) => {
      if (u.inputTokens || u.outputTokens) {
        reported = true
        recordUsage({ provider: provider.id, model, kind, inputTokens: u.inputTokens, outputTokens: u.outputTokens, estimated: false })
      }
    },
    finish: (outputText) => {
      if (reported) return
      recordUsage({
        provider: provider.id,
        model,
        kind,
        inputTokens: estimateTokens(promptText()),
        outputTokens: estimateTokens(outputText),
        estimated: true
      })
    }
  }
}

export function registerAiIpc(): void {
  ipcMain.handle(IPC.aiProviderStatus, () => listProviderStatus())
  ipcMain.handle(IPC.aiUsageSummary, () => getUsageSummary())

  ipcMain.handle(IPC.aiChip, async (_evt, req: ChipRequest): Promise<ChipResponse> => {
    const settings = await getSettings()
    try {
      assertEnabled(settings)
      const provider = resolveProvider(settings.provider)
      const model = provider.modelFor({ model: settings.chatModel })
      const { system, user } = buildChipPrompt(req)
      const rec = usageRecorder(provider, model, 'chip', () => system + user)
      const text = await provider.complete({
        system,
        messages: [{ role: 'user', text: user }],
        maxTokens: DIFF_CHIPS.has(req.chipId) ? 2048 : 700,
        model: settings.chatModel,
        onUsage: rec.onUsage
      })
      rec.finish(text)
      if (DIFF_CHIPS.has(req.chipId)) {
        return { chipId: req.chipId, summary: `Proposed by ${provider.label}.`, proposedCode: stripFences(text) }
      }
      return { chipId: req.chipId, summary: text.trim() }
    } catch (err) {
      if (!(err instanceof AiDisabledError)) logger.error('ai:chip', 'Chip request failed', err)
      return { chipId: req.chipId, summary: `Copilot error: ${(err as Error).message}` }
    }
  })

  ipcMain.handle(IPC.aiAsk, async (evt, raw: AskRequest): Promise<AskResponse> => {
    const settings = await getSettings()
    try {
      assertEnabled(settings)
      checkTurnRate(evt.sender)
      const req = trimForPrompt(raw)
      const provider = resolveProvider(settings.provider)
      const model = provider.modelFor({ model: settings.chatModel })
      const system = buildAskSystemPrompt(req)
      const rec = usageRecorder(provider, model, 'chat', () => system + req.messages.map((m) => m.text).join(''))
      const text = await provider.complete({
        system,
        messages: req.messages,
        maxTokens: req.spoken ? 900 : 1500,
        model: settings.chatModel,
        onUsage: rec.onUsage
      })
      rec.finish(text)
      return { text: text.trim() }
    } catch (err) {
      if (!(err instanceof AiDisabledError)) logger.error('ai:ask', 'Ask request failed', err)
      return { text: `Copilot error: ${(err as Error).message}` }
    }
  })

  /**
   * Streaming chat. Returns as soon as the stream is started; deltas arrive on IPC.aiStreamChunk and the
   * terminal event on IPC.aiStreamDone, both tagged with the caller's requestId.
   */
  ipcMain.handle(IPC.aiAskStream, async (evt, raw: AskStreamRequest): Promise<void> => {
    const settings = await getSettings()
    const sender = evt.sender
    const send = (channel: string, payload: StreamChunkEvent | StreamDoneEvent): void => {
      if (!sender.isDestroyed()) sender.send(channel, payload)
    }
    try {
      assertEnabled(settings)
      checkTurnRate(sender)
    } catch (err) {
      send(IPC.aiStreamDone, { requestId: raw.requestId, text: '', error: (err as Error).message })
      return
    }

    const req = trimForPrompt(raw)
    const provider = resolveProvider(settings.provider)
    const model = provider.modelFor({ model: settings.chatModel })
    const system = buildAskSystemPrompt(req)
    const rec = usageRecorder(provider, model, 'chat', () => system + req.messages.map((m) => m.text).join(''))
    const ac = new AbortController()
    activeStreams.set(req.requestId, ac)
    const meta = { provider: provider.id, model, startedAt: Date.now() }
    let partial = ''

    void provider
      .stream(
        {
          system,
          messages: req.messages,
          // Room for a LINES/REPLACE block on top of the spoken sentence: a truncated block is never applied.
          maxTokens: req.spoken ? 900 : 1500,
          model: settings.chatModel,
          signal: ac.signal,
          onUsage: rec.onUsage
        },
        (delta) => {
          partial += delta
          send(IPC.aiStreamChunk, { requestId: req.requestId, delta })
        }
      )
      .then((text) => {
        rec.finish(text)
        logTurn(req, meta, { reply: text })
        send(IPC.aiStreamDone, { requestId: req.requestId, text })
      })
      .catch((err) => {
        if (isAbort(err)) {
          logTurn(req, meta, { reply: partial, cancelled: true })
          send(IPC.aiStreamDone, { requestId: req.requestId, text: '', cancelled: true })
          return
        }
        logger.error('ai:askStream', 'Stream failed', err)
        logTurn(req, meta, { reply: partial, error: (err as Error).message })
        send(IPC.aiStreamDone, { requestId: req.requestId, text: '', error: (err as Error).message })
      })
      .finally(() => activeStreams.delete(req.requestId))
  })

  ipcMain.handle(IPC.aiStreamCancel, (_evt, requestId: string) => {
    activeStreams.get(requestId)?.abort()
  })

  ipcMain.handle(IPC.aiInlineComplete, async (_evt, req: InlineCompleteRequest): Promise<InlineCompleteResponse> => {
    const settings = await getSettings()
    if (!settings.inlineCompletions) return { text: '' }
    // Belt and braces: the renderer already skips these, but a stale request must not bill us for a disabled context.
    const kind = inlineContextKind(req.prefix, req.language)
    if ((kind === 'comment' && !settings.inlineInComments) || (kind === 'code' && !settings.inlineInCode)) return { text: '' }
    try {
      assertEnabled(settings)
    } catch {
      return { text: '' }
    }
    // Latency (and price) matter more than depth for ghost text: prefer Groq when it has a key.
    const groq = getProvider('groq')
    const provider = groq.isConfigured() ? groq : resolveProvider(settings.provider)
    const model = provider.modelFor({ model: settings.chatModel })

    inlineAbort?.abort()
    const ac = new AbortController()
    inlineAbort = ac
    const { system, user } = buildInlinePrompt(req, settings)
    const rec = usageRecorder(provider, model, 'inline', () => system + user)
    try {
      const text = await provider.complete({
        system,
        messages: [{ role: 'user', text: user }],
        maxTokens: inlineMaxTokens(settings.inlineScope, settings.inlineMaxLines),
        model: settings.chatModel,
        signal: ac.signal,
        onUsage: rec.onUsage
      })
      rec.finish(text)
      // With spelling help the answer starts from the first letter of the word, so the "echo of the current line" strip would misfire.
      const spelling = settings.inlineSpellAssist && kind === 'comment' && Boolean(req.partialWord)
      const cleaned = spelling ? stripFences(text).replace(/\s+$/, '') : cleanInline(stripFences(text), req.prefix)
      let out = limitInline(restoreFlattenedNewlines(cleaned), settings.inlineScope, settings.inlineMaxLines)
      // Short scopes: models like to restate the half-typed word ("comp" → "complement"); only the remainder may be inserted.
      const partial = req.partialWord ?? ''
      if (!spelling && partial && (settings.inlineScope === 'word' || settings.inlineScope === 'phrase') && out.length > partial.length && out.startsWith(partial)) {
        out = out.slice(partial.length)
      }
      return { text: out }
    } catch (err) {
      // Rate limits are already reported (throttled) by the provider; everything else is worth a line.
      if (!isAbort(err) && !/ 429[: ]/.test((err as Error).message)) logger.warn('ai:inline', 'Inline completion failed', (err as Error).message)
      return { text: '' }
    }
  })
}

/** Models sometimes wrap "return only code" answers in ```lang fences anyway — strip them defensively. */
function stripFences(text: string): string {
  const trimmed = text.trim()
  const fenceMatch = trimmed.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n?```$/)
  return fenceMatch ? fenceMatch[1] : trimmed
}

/** Drop a leading echo of the current line (models love to repeat it) and trailing whitespace. */
function cleanInline(text: string, prefix: string): string {
  const currentLine = prefix.slice(prefix.lastIndexOf('\n') + 1)
  let out = text.replace(/\s+$/, '')
  if (currentLine.trim() && out.startsWith(currentLine)) out = out.slice(currentLine.length)
  else if (currentLine.trim() && out.startsWith(currentLine.trimStart())) out = out.slice(currentLine.trimStart().length)
  return out
}

export function broadcastPaused(reason: string): void {
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(IPC.aiPaused, reason)
}
