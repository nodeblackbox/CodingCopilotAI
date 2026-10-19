import { app } from 'electron'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Playground, Settings } from '@shared/types'
import { INLINE_DEFAULTS } from '@shared/inline'
import { logger } from '@main/logger'
import { sessionLog } from '@main/services/sessionLog'

const DEFAULT_SETTINGS: Settings = {
  provider: 'anthropic',
  aiEnabled: true,
  chatModel: 'claude-haiku-4-5-20251001',
  dailyBudgetUsd: 2,
  language: 'python',
  guidedVoice: false,
  inlineCompletions: true,
  ...INLINE_DEFAULTS,
  helpStyle: 'coach',
  autoApplyEdits: true,
  ttsEngine: 'edge',
  voiceName: 'en-US-AvaNeural',
  voiceVolume: 0.9,
  shortcuts: {
    'Run code': 'Ctrl+Enter',
    'Toggle terminal': 'Ctrl+`',
    'Toggle AI panel': 'Ctrl+.',
    'Send chat message': 'Ctrl+Enter',
    'New playground': 'Ctrl+Shift+N'
  }
}

function dataDir(): string {
  return app.getPath('userData')
}

function settingsFile(): string {
  return join(dataDir(), 'settings.json')
}

function playgroundsDir(): string {
  return join(dataDir(), 'playgrounds')
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, 'utf8')
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) }
  } catch {
    return fallback
  }
}

export async function getSettings(): Promise<Settings> {
  const s = await readJson(settingsFile(), DEFAULT_SETTINGS)
  // Older files only had the guidedVoice switch; keep their choice. guidedVoice stays in sync for old readers.
  if (s.guidedVoice && s.helpStyle === DEFAULT_SETTINGS.helpStyle) {
    try {
      const raw = JSON.parse(await readFile(settingsFile(), 'utf8')) as object
      if (!('helpStyle' in raw)) s.helpStyle = 'guided'
    } catch {
      /* unreadable file: defaults already applied */
    }
  }
  return s
}

/** Writes are serialised so two quick saves can't interleave on the same file. */
let settingsWrite: Promise<unknown> = Promise.resolve()

export function setSettings(next: Settings): Promise<Settings> {
  const run = async (): Promise<Settings> => {
    const prev = await getSettings()
    const changed = (Object.keys(next) as Array<keyof Settings>).filter(
      (k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k])
    )
    if (!changed.length) return next // nothing to write, nothing to log
    await mkdir(dataDir(), { recursive: true })
    await writeFile(settingsFile(), JSON.stringify(next, null, 2), 'utf8')
    sessionLog('settings', 'changed', Object.fromEntries(changed.map((k) => [k, { from: prev[k], to: next[k] }])))
    return next
  }
  const result = settingsWrite.then(run, run)
  settingsWrite = result.catch(() => undefined)
  return result
}

export async function listPlaygrounds(): Promise<Playground[]> {
  const dir = playgroundsDir()
  await mkdir(dir, { recursive: true })
  const files = await readdir(dir).catch(() => [])
  const playgrounds: Playground[] = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    try {
      const raw = await readFile(join(dir, f), 'utf8')
      playgrounds.push(JSON.parse(raw) as Playground)
    } catch (err) {
      logger.warn('store', `Skipping unreadable playground file ${f}`, err)
    }
  }
  return playgrounds.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getPlayground(id: string): Promise<Playground | null> {
  try {
    const raw = await readFile(join(playgroundsDir(), `${id}.json`), 'utf8')
    return JSON.parse(raw) as Playground
  } catch {
    return null
  }
}

export async function savePlayground(playground: Playground): Promise<Playground> {
  const dir = playgroundsDir()
  await mkdir(dir, { recursive: true })
  const withTimestamp: Playground = { ...playground, updatedAt: Date.now() }
  await writeFile(join(dir, `${playground.id}.json`), JSON.stringify(withTimestamp, null, 2), 'utf8')
  return withTimestamp
}

export async function deletePlayground(id: string): Promise<void> {
  await rm(join(playgroundsDir(), `${id}.json`), { force: true })
}
