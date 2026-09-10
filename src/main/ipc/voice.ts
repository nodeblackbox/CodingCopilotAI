import { ipcMain } from 'electron'
import { IPC } from '@shared/types'
import { getVoiceState, startVoiceSidecar, stopVoiceSidecar } from '@main/services/voiceSidecar'

export function registerVoiceIpc(): void {
  ipcMain.handle(IPC.voiceStart, () => startVoiceSidecar())
  ipcMain.handle(IPC.voiceStop, () => stopVoiceSidecar())
  ipcMain.handle(IPC.voiceStatus, () => getVoiceState())
}
