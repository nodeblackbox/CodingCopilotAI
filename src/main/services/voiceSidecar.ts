import { app, BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { IPC } from '@shared/types'
import type { VoiceSidecarState } from '@shared/types'
import { logger } from '@main/logger'
import { sessionLog } from '@main/services/sessionLog'

/**
 * Lifecycle of the Python voice sidecar (voice/server.py): spawn, discover its port from stdout,
 * broadcast state to the renderer, kill on quit. The renderer talks to it directly over a local
 * WebSocket (mic audio in, transcripts + TTS audio out) — main only owns the process.
 */

let child: ChildProcess | null = null
let state: VoiceSidecarState = { status: 'off', port: null }
let startPromise: Promise<VoiceSidecarState> | null = null
/** Set when WE kill the sidecar (quit, stop button, start timeout) so its exit isn't reported as a crash. */
let stopping = false

/** `@ev {json}` lines from voice/server.py's jlog() become structured session events; anything else is raw text. */
function handleSidecarLine(line: string): void {
  if (line.startsWith('@ev ')) {
    try {
      const { ev, ...data } = JSON.parse(line.slice(4)) as { ev: string } & Record<string, unknown>
      const bad = /crash|error|gave_up|failed/.test(ev)
      sessionLog('sidecar', ev, data, bad ? 'error' : 'info')
      return
    } catch {
      // fall through and keep the raw line
    }
  }
  logger.info('voice:py', line)
}

function broadcast(next: VoiceSidecarState): void {
  if (next.status !== state.status || next.message !== state.message) {
    sessionLog('voice', 'sidecar_state', { status: next.status, port: next.port, message: next.message }, next.status === 'error' ? 'error' : 'info')
  }
  state = next
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.voiceStateChanged, state)
  }
}

export function getVoiceState(): VoiceSidecarState {
  return state
}

function pythonCommand(): { cmd: string; args: string[] } {
  const custom = process.env.VOICE_PYTHON?.trim()
  if (custom) return { cmd: custom, args: [] }
  return process.platform === 'win32' ? { cmd: 'py', args: ['-3'] } : { cmd: 'python3', args: [] }
}

export function startVoiceSidecar(): Promise<VoiceSidecarState> {
  if (state.status === 'ready') return Promise.resolve(state)
  if (startPromise) return startPromise

  startPromise = new Promise<VoiceSidecarState>((resolve) => {
    const { cmd, args } = pythonCommand()
    const script = join(app.getAppPath(), 'voice', 'server.py')
    broadcast({ status: 'starting', port: null, message: 'Starting Python voice server…' })
    logger.info('voice', `Spawning ${cmd} ${[...args, script].join(' ')}`)

    let settled = false
    const finish = (next: VoiceSidecarState): void => {
      if (settled) return
      settled = true
      startPromise = null
      broadcast(next)
      resolve(next)
    }

    try {
      child = spawn(cmd, [...args, '-u', script], {
        cwd: app.getAppPath(),
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PREP_PARENT_WATCH: '1' } // child exits when our stdin pipe closes
      })
    } catch (err) {
      finish({ status: 'error', port: null, message: `Could not start Python: ${(err as Error).message}` })
      return
    }

    const timer = setTimeout(() => {
      finish({ status: 'error', port: null, message: 'Voice server did not report a port within 60s' })
      stopVoiceSidecar()
    }, 60_000)

    child.stdout?.on('data', (buf: Buffer) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (!line) continue
        handleSidecarLine(line)
        const m = line.match(/^VOICE_PORT=(\d+)/)
        if (m) {
          clearTimeout(timer)
          finish({ status: 'ready', port: Number(m[1]) })
        }
      }
    })
    child.stderr?.on('data', (buf: Buffer) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) if (line) logger.warn('voice:py', line)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      finish({ status: 'error', port: null, message: `Python failed to start: ${err.message}` })
      child = null
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      const intentional = stopping
      stopping = false
      logger.info('voice', `Sidecar exited with code ${code}${intentional ? ' (requested)' : ''}`)
      child = null
      if (intentional) code = 0
      const msg = code === 0 ? undefined : `Voice server exited with code ${code} — see the session log (Debug menu → Open logs folder)`
      finish({ status: code === 0 ? 'off' : 'error', port: null, message: msg })
      if (settled) broadcast({ status: code === 0 ? 'off' : 'error', port: null, message: msg })
    })
  })

  return startPromise
}

export function stopVoiceSidecar(): void {
  if (child) {
    logger.info('voice', 'Stopping sidecar')
    stopping = true
    child.kill()
    child = null
  }
  broadcast({ status: 'off', port: null })
}
