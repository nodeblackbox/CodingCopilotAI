import { app } from 'electron'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Playground, Settings } from '@shared/types'
import { logger } from '@main/logger'

const DEFAULT_SETTINGS: Settings = {
  provider: 'anthropic',
  language: 'python',
  guidedVoice: false,
  inlineCompletions: true,
  ttsEngine: 'edge',
  voiceName: 'en-US-AvaNeural',
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
  return readJson(settingsFile(), DEFAULT_SETTINGS)
}

export async function setSettings(next: Settings): Promise<Settings> {
  await mkdir(dataDir(), { recursive: true })
  await writeFile(settingsFile(), JSON.stringify(next, null, 2), 'utf8')
  logger.info('store', 'Settings saved')
  return next
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
