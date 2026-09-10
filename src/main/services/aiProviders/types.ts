import type { AiProviderId, ChatMessage } from '@shared/types'

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

export interface CompletionRequest {
  system: string
  messages: ChatMessage[]
  maxTokens?: number
  /** Provider-specific model id override (Anthropic: Haiku vs Sonnet). */
  model?: string
  /** Abort the underlying HTTP request (used for chat cancel / barge-in and stale inline completions). */
  signal?: AbortSignal
  /** Called once with the token counts the API reported, so spend can be tracked exactly. */
  onUsage?: (usage: TokenUsage) => void
}

export interface AiProvider {
  id: AiProviderId
  label: string
  /** The model a request will use (for the ledger). */
  modelFor(req: Pick<CompletionRequest, 'model'>): string
  isConfigured(): boolean
  /** One-shot completion. */
  complete(req: CompletionRequest): Promise<string>
  /** Streams text deltas via onDelta; resolves with the full text. Rejects on abort with an AbortError. */
  stream(req: CompletionRequest, onDelta: (delta: string) => void): Promise<string>
}
