import type { AiProvider, CompletionRequest } from './types'
import { readSse, httpError } from './sse'
import { logger } from '@main/logger'

// Alias that tracks the current flash model, so this doesn't rot when Google retires a version.
const MODEL = 'gemini-flash-latest'
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

/** Read at call time, not module-eval time: ES imports are hoisted above dotenv.config(). */
const getApiKey = (): string => process.env.GEMINI_API_KEY?.trim() ?? ''

function body(req: CompletionRequest): string {
  return JSON.stringify({
    systemInstruction: { role: 'system', parts: [{ text: req.system }] },
    contents: req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] })),
    generationConfig: { maxOutputTokens: req.maxTokens ?? 1024 }
  })
}

async function post(req: CompletionRequest, stream: boolean): Promise<Response> {
  const apiKey = getApiKey()
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set. Add it to .env and restart.')
  const method = stream ? 'streamGenerateContent?alt=sse&' : 'generateContent?'
  const res = await fetch(`${BASE}/${MODEL}:${method}key=${apiKey}`, {
    method: 'POST',
    signal: req.signal,
    headers: { 'content-type': 'application/json' },
    body: body(req)
  })
  if (!res.ok) {
    const err = await httpError(res, 'Gemini')
    logger.error('gemini', err.message)
    throw err
  }
  return res
}

type GeminiChunk = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
}
const textOf = (c: GeminiChunk): string => (c.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('')
const usageOf = (c: GeminiChunk) => ({
  inputTokens: c.usageMetadata?.promptTokenCount ?? 0,
  outputTokens: c.usageMetadata?.candidatesTokenCount ?? 0
})

export function createGeminiProvider(): AiProvider {
  return {
    id: 'gemini',
    label: 'Google Gemini',
    modelFor: () => MODEL,
    isConfigured: () => getApiKey().length > 0,

    async complete(req) {
      const res = await post(req, false)
      const data = (await res.json()) as GeminiChunk
      req.onUsage?.(usageOf(data))
      return textOf(data)
    },

    async stream(req, onDelta) {
      const res = await post(req, true)
      let full = ''
      let last: GeminiChunk = {}
      await readSse(res, (data) => {
        let evt: GeminiChunk
        try {
          evt = JSON.parse(data)
        } catch {
          return
        }
        if (evt.usageMetadata) last = evt
        const delta = textOf(evt)
        if (delta) {
          full += delta
          onDelta(delta)
        }
      })
      req.onUsage?.(usageOf(last))
      return full
    }
  }
}
