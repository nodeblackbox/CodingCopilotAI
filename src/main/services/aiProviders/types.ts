import type { AiProviderId, ChatMessage } from '@shared/types'

export interface CompletionRequest {
  system: string
  messages: ChatMessage[]
  maxTokens?: number
  /** Abort the underlying HTTP request (used for chat cancel / barge-in and stale inline completions). */
  signal?: AbortSignal
}

export interface AiProvider {
  id: AiProviderId
  label: string
  isConfigured(): boolean
  /** One-shot completion. */
  complete(req: CompletionRequest): Promise<string>
  /** Streams text deltas via onDelta; resolves with the full text. Rejects on abort with an AbortError. */
  stream(req: CompletionRequest, onDelta: (delta: string) => void): Promise<string>
}
