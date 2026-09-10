import { ipcMain } from 'electron'
import { IPC } from '@shared/types'
import type { Playground, Settings } from '@shared/types'
import * as store from '@main/services/store'

export function registerStorageIpc(): void {
  ipcMain.handle(IPC.storeGetSettings, () => store.getSettings())
  ipcMain.handle(IPC.storeSetSettings, (_evt, settings: Settings) => store.setSettings(settings))
  ipcMain.handle(IPC.storeListPlaygrounds, () => store.listPlaygrounds())
  ipcMain.handle(IPC.storeGetPlayground, (_evt, id: string) => store.getPlayground(id))
  ipcMain.handle(IPC.storeSavePlayground, (_evt, playground: Playground) => store.savePlayground(playground))
  ipcMain.handle(IPC.storeDeletePlayground, (_evt, id: string) => store.deletePlayground(id))
}
