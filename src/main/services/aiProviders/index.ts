import type { AiProviderId, ProviderStatus } from '@shared/types'
import type { AiProvider } from './types'
import { createAnthropicProvider } from './anthropic'
import { createGroqProvider } from './groq'
import { createGeminiProvider } from './gemini'

const registry: Record<AiProviderId, AiProvider> = {
  anthropic: createAnthropicProvider(),
  groq: createGroqProvider(),
  gemini: createGeminiProvider()
}

export function getProvider(id: AiProviderId): AiProvider {
  return registry[id]
}

/** Preferred provider, falling back to the first configured one so a missing key doesn't brick the app. */
export function resolveProvider(preferred: AiProviderId): AiProvider {
  const p = registry[preferred]
  if (p.isConfigured()) return p
  const fallback = Object.values(registry).find((candidate) => candidate.isConfigured())
  if (fallback) return fallback
  return p // still return it — caller will surface the "not configured" error
}

export function listProviderStatus(): ProviderStatus[] {
  return Object.values(registry).map((p) => ({
    id: p.id,
    label: p.label,
    configured: p.isConfigured()
  }))
}

export type { AiProvider } from './types'
