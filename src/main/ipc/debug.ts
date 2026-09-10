import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '@shared/types'
import { logger } from '@main/logger'

export function registerDebugIpc(): void {
  ipcMain.handle(IPC.debugOpenDevtools, (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender)
    win?.webContents.openDevTools({ mode: 'right' })
  })

  ipcMain.handle(IPC.debugGetLogPath, () => logger.getLogPath())
}
