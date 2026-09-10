/// <reference types="vite/client" />

import type {
  AskRequest,
  AskResponse,
  AskStreamRequest,
  ChipRequest,
  ChipResponse,
  InlineCompleteRequest,
  InlineCompleteResponse,
  Playground,
  ProviderStatus,
  RunRequest,
  RunResult,
  Settings,
  StreamChunkEvent,
  StreamDoneEvent,
  UsageEvent,
  UsageSummary,
  VoiceSidecarState
} from '@shared/types'

type Unsubscribe = () => void

/** Mirrors src/preload/index.ts's exposeInMainWorld shape (kept separate to avoid cross-tsconfig-project includes). */
export interface PrepApi {
  ai: {
    ask: (req: AskRequest) => Promise<AskResponse>
    askStream: (req: AskStreamRequest) => Promise<void>
    cancelStream: (requestId: string) => Promise<void>
    onStreamChunk: (cb: (e: StreamChunkEvent) => void) => Unsubscribe
    onStreamDone: (cb: (e: StreamDoneEvent) => void) => Unsubscribe
    chip: (req: ChipRequest) => Promise<ChipResponse>
    inlineComplete: (req: InlineCompleteRequest) => Promise<InlineCompleteResponse>
    providerStatus: () => Promise<ProviderStatus[]>
    usageSummary: () => Promise<UsageSummary>
    onUsage: (cb: (e: { event: UsageEvent; summary: UsageSummary }) => void) => Unsubscribe
    onPaused: (cb: (reason: string) => void) => Unsubscribe
  }
  run: {
    code: (req: RunRequest) => Promise<RunResult>
  }
  store: {
    getSettings: () => Promise<Settings>
    setSettings: (settings: Settings) => Promise<Settings>
    listPlaygrounds: () => Promise<Playground[]>
    getPlayground: (id: string) => Promise<Playground | null>
    savePlayground: (playground: Playground) => Promise<Playground>
    deletePlayground: (id: string) => Promise<void>
  }
  voice: {
    start: () => Promise<VoiceSidecarState>
    stop: () => Promise<void>
    status: () => Promise<VoiceSidecarState>
    onStateChanged: (cb: (s: VoiceSidecarState) => void) => Unsubscribe
  }
  debug: {
    openDevtools: () => Promise<void>
    getLogPath: () => Promise<string>
  }
}

declare global {
  interface Window {
    api: PrepApi
  }
}
