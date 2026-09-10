import type { AiProvider, CompletionRequest } from './types'
import { readSse, httpError } from './sse'
import { logger } from '@main/logger'

const API_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-sonnet-5'

/** Read at call time, not module-eval time: ES imports are hoisted above dotenv.config(). */
const getApiKey = (): string => process.env.ANTHROPIC_API_KEY?.trim() ?? ''

function body(req: CompletionRequest, stream: boolean): string {
  return JSON.stringify({
    model: MODEL,
    max_tokens: req.maxTokens ?? 1024,
    system: req.system,
    stream,
    messages: req.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.text }))
  })
}

async function post(req: CompletionRequest, stream: boolean): Promise<Response> {
  const apiKey = getApiKey()
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set. Add it to .env and restart.')
  const res = await fetch(API_URL, {
    method: 'POST',
    signal: req.signal,
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: body(req, stream)
  })
  if (!res.ok) {
    const err = await httpError(res, 'Anthropic')
    logger.error('anthropic', err.message)
    throw err
  }
  return res
}

export function createAnthropicProvider(): AiProvider {
  return {
    id: 'anthropic',
    label: 'Anthropic Claude',
    isConfigured: () => getApiKey().length > 0,

    async complete(req) {
      const res = await post(req, false)
      const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> }
      return data.content?.find((b) => b.type === 'text')?.text ?? ''
    },

    async stream(req, onDelta) {
      const res = await post(req, true)
      let full = ''
      await readSse(res, (data) => {
        let evt: { type?: string; delta?: { type?: string; text?: string } }
        try {
          evt = JSON.parse(data)
        } catch {
          return
        }
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
          full += evt.delta.text
          onDelta(evt.delta.text)
        }
      })
      return full
    }
  }
}
