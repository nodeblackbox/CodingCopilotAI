import './env' // must stay first: populates process.env before anything else loads
import { app, shell, BrowserWindow, Menu, session } from 'electron'
import { join } from 'node:path'
import { logger } from './logger'
import { registerAiIpc } from './ipc/ai'
import { registerRunIpc } from './ipc/run'
import { registerStorageIpc } from './ipc/storage'
import { registerDebugIpc } from './ipc/debug'
import { registerVoiceIpc } from './ipc/voice'
import { stopVoiceSidecar } from './services/voiceSidecar'

const isDev = !app.isPackaged

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 700,
    show: false,
    backgroundColor: '#0a0c11',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  if (isDev || process.env.PREP_DEBUG === '1') {
    win.webContents.openDevTools({ mode: 'right' })
  }

  win.webContents.on('did-fail-load', (_e, code, description) => {
    logger.error('window', `Failed to load renderer: ${description} (${code})`)
  })

  return win
}

function buildDebugMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Debug',
      submenu: [
        {
          label: 'Open log file location',
          click: () => shell.showItemInFolder(logger.getLogPath())
        },
        {
          label: 'Reveal userData folder',
          click: () => shell.openPath(app.getPath('userData'))
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(() => {
  logger.info('app', `Starting prep-copilot, dev=${isDev}, log=${logger.getLogPath()}`)

  // Restrictive CSP for the renderer. Monaco assets are bundled, not CDN-loaded. The only network the
  // renderer may touch is the local Python voice sidecar (WebSocket on 127.0.0.1) — AI keys stay in main.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' 'unsafe-inline' data: blob:; script-src 'self' 'unsafe-inline' blob:; " +
            "connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*; media-src 'self' blob: data:"
        ]
      }
    })
  })

  // Microphone access for the voice copilot. Everything else stays denied.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })

  registerAiIpc()
  registerRunIpc()
  registerStorageIpc()
  registerDebugIpc()
  registerVoiceIpc()
  buildDebugMenu()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => stopVoiceSidecar())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

process.on('uncaughtException', (err) => {
  logger.error('process', 'Uncaught exception', String(err?.stack ?? err))
})
