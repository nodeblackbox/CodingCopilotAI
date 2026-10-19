import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/types'
import type {
  AskRequest,
  AskResponse,
  AskStreamRequest,
  ChipRequest,
  ChipResponse,
  InlineCompleteRequest,
  InlineCompleteResponse,
  LogEventInput,
  SessionInfo,
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

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const handler = (_evt: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

/**
 * Everything the renderer can touch. No direct Node/fs/child_process access is exposed —
 * only these specific, typed operations, each backed by an ipcMain.handle in src/main/ipc/*.
 */
const api = {
  ai: {
    ask: (req: AskRequest): Promise<AskResponse> => ipcRenderer.invoke(IPC.aiAsk, req),
    askStream: (req: AskStreamRequest): Promise<void> => ipcRenderer.invoke(IPC.aiAskStream, req),
    cancelStream: (requestId: string): Promise<void> => ipcRenderer.invoke(IPC.aiStreamCancel, requestId),
    onStreamChunk: (cb: (e: StreamChunkEvent) => void): Unsubscribe => subscribe(IPC.aiStreamChunk, cb),
    onStreamDone: (cb: (e: StreamDoneEvent) => void): Unsubscribe => subscribe(IPC.aiStreamDone, cb),
    chip: (req: ChipRequest): Promise<ChipResponse> => ipcRenderer.invoke(IPC.aiChip, req),
    inlineComplete: (req: InlineCompleteRequest): Promise<InlineCompleteResponse> =>
      ipcRenderer.invoke(IPC.aiInlineComplete, req),
    providerStatus: (): Promise<ProviderStatus[]> => ipcRenderer.invoke(IPC.aiProviderStatus),
    usageSummary: (): Promise<UsageSummary> => ipcRenderer.invoke(IPC.aiUsageSummary),
    onUsage: (cb: (e: { event: UsageEvent; summary: UsageSummary }) => void): Unsubscribe => subscribe(IPC.aiUsage, cb),
    onPaused: (cb: (reason: string) => void): Unsubscribe => subscribe(IPC.aiPaused, cb)
  },
  run: {
    code: (req: RunRequest): Promise<RunResult> => ipcRenderer.invoke(IPC.runCode, req)
  },
  store: {
    getSettings: (): Promise<Settings> => ipcRenderer.invoke(IPC.storeGetSettings),
    setSettings: (settings: Settings): Promise<Settings> => ipcRenderer.invoke(IPC.storeSetSettings, settings),
    listPlaygrounds: (): Promise<Playground[]> => ipcRenderer.invoke(IPC.storeListPlaygrounds),
    getPlayground: (id: string): Promise<Playground | null> => ipcRenderer.invoke(IPC.storeGetPlayground, id),
    savePlayground: (playground: Playground): Promise<Playground> =>
      ipcRenderer.invoke(IPC.storeSavePlayground, playground),
    deletePlayground: (id: string): Promise<void> => ipcRenderer.invoke(IPC.storeDeletePlayground, id)
  },
  voice: {
    start: (): Promise<VoiceSidecarState> => ipcRenderer.invoke(IPC.voiceStart),
    stop: (): Promise<void> => ipcRenderer.invoke(IPC.voiceStop),
    status: (): Promise<VoiceSidecarState> => ipcRenderer.invoke(IPC.voiceStatus),
    onStateChanged: (cb: (s: VoiceSidecarState) => void): Unsubscribe => subscribe(IPC.voiceStateChanged, cb)
  },
  debug: {
    openDevtools: (): Promise<void> => ipcRenderer.invoke(IPC.debugOpenDevtools),
    getLogPath: (): Promise<string> => ipcRenderer.invoke(IPC.debugGetLogPath),
    openLogsDir: (): Promise<string> => ipcRenderer.invoke(IPC.debugOpenLogsDir),
    sessionInfo: (): Promise<SessionInfo> => ipcRenderer.invoke(IPC.debugSessionInfo),
    logEvents: (events: LogEventInput[]): void => ipcRenderer.send(IPC.logEvents, events)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type PrepApi = typeof api
