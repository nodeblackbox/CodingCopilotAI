import { ipcMain, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { IPC } from '@shared/types'
import type { LogEventInput, SessionInfo } from '@shared/types'
import { logger } from '@main/logger'
import {
  convoLog,
  getConversationFile,
  getSessionFile,
  getSessionId,
  sessionFileSize,
  sessionLog,
  sessionsDir
} from '@main/services/sessionLog'

export function registerDebugIpc(): void {
  ipcMain.handle(IPC.debugOpenDevtools, (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender)
    win?.webContents.openDevTools({ mode: 'right' })
  })

  ipcMain.handle(IPC.debugGetLogPath, () => logger.getLogPath())

  // The parent folder holds both sessions/ and conversations/.
  ipcMain.handle(IPC.debugOpenLogsDir, () => shell.openPath(join(sessionsDir(), '..')))

  ipcMain.handle(
    IPC.debugSessionInfo,
    (): SessionInfo => ({
      sessionId: getSessionId(),
      file: getSessionFile(),
      dir: sessionsDir(),
      conversationFile: getConversationFile(),
      bytes: sessionFileSize()
    })
  )

  // Fire-and-forget batches from the renderer. Never throws back at the caller.
  ipcMain.on(IPC.logEvents, (_evt, events: LogEventInput[]) => {
    if (!Array.isArray(events)) return
    for (const e of events.slice(0, 500)) {
      if (!e || typeof e.cat !== 'string' || typeof e.ev !== 'string') continue
      // cat 'convo' is the conversation file; everything else is the technical session timeline.
      if (e.cat === 'convo') convoLog(e.ev, e.data, e.level ?? 'info')
      else sessionLog(e.cat, e.ev, e.data, e.level ?? 'info')
    }
  })
}
