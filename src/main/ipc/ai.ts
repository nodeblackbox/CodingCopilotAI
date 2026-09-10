import { ipcMain } from 'electron'
import { IPC, DIFF_CHIPS } from '@shared/types'
import type {
  AskRequest,
  AskResponse,
  AskStreamRequest,
  ChipRequest,
  ChipResponse,
  InlineCompleteRequest,
  InlineCompleteResponse,
  StreamChunkEvent,
  StreamDoneEvent
} from '@shared/types'
import { getProvider, resolveProvider, listProviderStatus } from '@main/services/aiProviders'
import { buildAskSystemPrompt, buildChipPrompt, buildInlinePrompt } from '@main/services/prompts'
import { getSettings } from '@main/services/store'
import { logger } from '@main/logger'

/** In-flight streams by requestId, so the renderer can cancel (barge-in, new message). */
const activeStreams = new Map<string, AbortController>()

/** Inline completions: only the newest request matters; abort the previous one on arrival. */
let inlineAbort: AbortController | null = null

const isAbort = (err: unknown): boolean => (err as Error)?.name === 'AbortError'

export function registerAiIpc(): void {
  ipcMain.handle(IPC.aiProviderStatus, () => listProviderStatus())

  ipcMain.handle(IPC.aiChip, async (_evt, req: ChipRequest): Promise<ChipResponse> => {
    const settings = await getSettings()
    const provider = resolveProvider(settings.provider)
    const { system, user } = buildChipPrompt(req)

    try {
      const text = await provider.complete({
        system,
        messages: [{ role: 'user', text: user }],
        maxTokens: DIFF_CHIPS.has(req.chipId) ? 2048 : 700
      })

      if (DIFF_CHIPS.has(req.chipId)) {
        return { chipId: req.chipId, summary: `Proposed by ${provider.label}.`, proposedCode: stripFences(text) }
      }
      return { chipId: req.chipId, summary: text.trim() }
    } catch (err) {
      logger.error('ai:chip', 'Chip request failed', err)
      return { chipId: req.chipId, summary: `Copilot error: ${(err as Error).message}` }
    }
  })

  ipcMain.handle(IPC.aiAsk, async (_evt, req: AskRequest): Promise<AskResponse> => {
    const settings = await getSettings()
    const provider = resolveProvider(settings.provider)
    try {
      const text = await provider.complete({
        system: buildAskSystemPrompt(req),
        messages: req.messages,
        maxTokens: req.guidedVoice ? 200 : 900
      })
      return { text: text.trim() }
    } catch (err) {
      logger.error('ai:ask', 'Ask request failed', err)
      return { text: `Copilot error: ${(err as Error).message}` }
    }
  })

  /**
   * Streaming chat. Returns as soon as the stream is started; deltas arrive on IPC.aiStreamChunk and the
   * terminal event on IPC.aiStreamDone, both tagged with the caller's requestId.
   */
  ipcMain.handle(IPC.aiAskStream, async (evt, req: AskStreamRequest): Promise<void> => {
    const settings = await getSettings()
    const provider = resolveProvider(settings.provider)
    const ac = new AbortController()
    activeStreams.set(req.requestId, ac)
    const sender = evt.sender
    const send = (channel: string, payload: StreamChunkEvent | StreamDoneEvent): void => {
      if (!sender.isDestroyed()) sender.send(channel, payload)
    }

    void provider
      .stream(
        {
          system: buildAskSystemPrompt(req),
          messages: req.messages,
          maxTokens: req.guidedVoice ? 200 : req.spoken ? 300 : 900,
          signal: ac.signal
        },
        (delta) => send(IPC.aiStreamChunk, { requestId: req.requestId, delta })
      )
      .then((text) => send(IPC.aiStreamDone, { requestId: req.requestId, text }))
      .catch((err) => {
        if (isAbort(err)) {
          send(IPC.aiStreamDone, { requestId: req.requestId, text: '', cancelled: true })
          return
        }
        logger.error('ai:askStream', 'Stream failed', err)
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
    // Latency matters more than depth for ghost text: prefer Groq when it has a key.
    const groq = getProvider('groq')
    const provider = groq.isConfigured() ? groq : resolveProvider(settings.provider)

    inlineAbort?.abort()
    const ac = new AbortController()
    inlineAbort = ac
    const { system, user } = buildInlinePrompt(req)
    try {
      const text = await provider.complete({
        system,
        messages: [{ role: 'user', text: user }],
        maxTokens: 160,
        signal: ac.signal
      })
      return { text: cleanInline(stripFences(text), req.prefix) }
    } catch (err) {
      if (!isAbort(err)) logger.warn('ai:inline', 'Inline completion failed', (err as Error).message)
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
