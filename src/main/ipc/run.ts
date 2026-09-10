import { ipcMain } from 'electron'
import { IPC } from '@shared/types'
import type { RunRequest, RunResult } from '@shared/types'
import { runCode } from '@main/services/pythonRunner'
import { logger } from '@main/logger'

export function registerRunIpc(): void {
  ipcMain.handle(IPC.runCode, async (_evt, req: RunRequest): Promise<RunResult> => {
    logger.debug('run:code', `Running ${req.language} snippet (${req.code.length} chars)`)
    return runCode(req)
  })
}
