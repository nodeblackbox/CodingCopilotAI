import type { AiProvider, CompletionRequest } from './types'
import { readSse, httpError } from './sse'
import { logger } from '@main/logger'

const API_URL = 'https://api.groq.com/openai/v1/chat/completions'
// Verified against GET /openai/v1/models on 2026-09-10; older llama-3.x ids have been retired.
const MODEL = 'openai/gpt-oss-120b'

/** Read at call time, not module-eval time: ES imports are hoisted above dotenv.config(). */
const getApiKey = (): string => process.env.GROQ_API_KEY?.trim() ?? ''

function body(req: CompletionRequest, stream: boolean): string {
  return JSON.stringify({
    model: MODEL,
    max_tokens: req.maxTokens ?? 1024,
    stream,
    // gpt-oss is a reasoning model; without this it can burn the whole budget thinking and return "".
    reasoning_effort: 'low',
    messages: [
      { role: 'system', content: req.system },
      ...req.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.text }))
    ]
  })
}

async function post(req: CompletionRequest, stream: boolean): Promise<Response> {
  const apiKey = getApiKey()
  if (!apiKey) throw new Error('GROQ_API_KEY is not set. Add it to .env and restart.')
  const res = await fetch(API_URL, {
    method: 'POST',
    signal: req.signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: body(req, stream)
  })
  if (!res.ok) {
    const err = await httpError(res, 'Groq')
    logger.error('groq', err.message)
    throw err
  }
  return res
}

/** Groq: OpenAI-compatible chat endpoint, prized for low latency (inline completions + voice turns). */
export function createGroqProvider(): AiProvider {
  return {
    id: 'groq',
    label: 'Groq (gpt-oss)',
    isConfigured: () => getApiKey().length > 0,

    async complete(req) {
      const res = await post(req, false)
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      return data.choices?.[0]?.message?.content ?? ''
    },

    async stream(req, onDelta) {
      const res = await post(req, true)
      let full = ''
      await readSse(res, (data) => {
        if (data === '[DONE]') return
        let evt: { choices?: Array<{ delta?: { content?: string } }> }
        try {
          evt = JSON.parse(data)
        } catch {
          return
        }
        const delta = evt.choices?.[0]?.delta?.content
        if (delta) {
          full += delta
          onDelta(delta)
        }
      })
      return full
    }
  }
}
