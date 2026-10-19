// Records the README demo: drives the BUILT app (run `npm run build` first) through a short scripted
// tour with Playwright and writes a video plus a few screenshots.
//
//   npm run build && node scripts/record-demo.mjs
//   OUT_DIR=docs/media node scripts/record-demo.mjs      (default: <os tmp>/prep-demo)
//
// It starts from a throwaway --user-data-dir, so none of your own playgrounds, history or settings
// appear on screen. It makes ~2 small model calls (needs a key in .env) and never opens Settings,
// so no keys can end up in a frame. Convert the .webm to a gif with ffmpeg, e.g.
//   ffmpeg -i demo.webm -vf "fps=14,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" demo.gif
import { _electron as electron } from 'playwright-core'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const OUT_DIR = path.resolve(process.env.OUT_DIR || path.join(os.tmpdir(), 'prep-demo'))
const VIDEO_DIR = path.join(OUT_DIR, 'video')
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-demo-profile-'))
fs.mkdirSync(VIDEO_DIR, { recursive: true })
// DEMO_PROVIDER picks the model provider for the take (anthropic | groq | gemini); needs that key in .env.
fs.writeFileSync(path.join(USER_DATA, 'settings.json'), JSON.stringify({ provider: process.env.DEMO_PROVIDER || 'anthropic' }))

const electronBin = path.join(
  APP_DIR,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron'
)

const pause = (page, ms) => page.waitForTimeout(ms)
const shot = (page, name) => page.screenshot({ path: path.join(OUT_DIR, name + '.png') })
const clickTestId = (page, id) =>
  page.evaluate((s) => {
    const el = document.querySelector(`[data-testid="${s}"]`)
    if (!el || el.disabled) return false
    el.click()
    return true
  }, id)
const clickButtonText = (page, text) =>
  page.evaluate((t) => {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === t)
    if (!el) return false
    el.click()
    return true
  }, text)
const clickTitle = (page, title) => page.evaluate((t) => document.querySelector(`button[title="${t}"]`)?.click(), title)
async function waitFor(page, predicate, { tries = 120, every = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (await page.evaluate(predicate)) return true
    await page.waitForTimeout(every)
  }
  return false
}
/** Type into the copilot input like a person, then send. */
async function say(page, text) {
  await page.click('[data-testid="chat-input"]')
  await page.keyboard.type(text, { delay: 45 })
  await pause(page, 350)
  await clickTestId(page, 'chat-send')
}
const replyDone = (page) => waitFor(page, () => !document.querySelector('[data-testid="stop-reply"]'), { tries: 160 })

async function main() {
  const app = await electron.launch({
    executablePath: electronBin,
    args: [APP_DIR, `--user-data-dir=${USER_DATA}`],
    timeout: 30_000,
    recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 900 } }
  })
  let page = null
  for (let i = 0; i < 50 && !page; i++) {
    page = app.windows().find((w) => w.url().startsWith('file://'))
    if (!page) await new Promise((r) => setTimeout(r, 200))
  }
  if (!page) throw new Error('app window never appeared')
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().startsWith('file://'))
    w?.setContentSize(1440, 900)
    w?.center()
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForSelector('.monaco-editor', { timeout: 15_000 })
  await pause(page, 1800)
  await shot(page, 'workspace')

  // 1. Run the starter locally
  await clickButtonText(page, 'Run')
  await waitFor(page, () => document.body.innerText.includes('Exited'), { tries: 60 })
  await pause(page, 1500)
  await shot(page, 'run')

  // 2. Highlight + explain (highlight is local and instant; the explanation streams from the model)
  await clickTestId(page, 'mode-ask')
  await pause(page, 500)
  await say(page, 'highlight lines 3 to 6 and explain it')
  await pause(page, 2500)
  await shot(page, 'highlight-streaming')
  await replyDone(page)
  await pause(page, 2500)
  await shot(page, 'highlight-explain')

  // 3. Agent chip -> diff -> Accept
  await clickTestId(page, 'mode-agent')
  await pause(page, 800)
  await clickButtonText(page, 'Optimize solution')
  await waitFor(page, () => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Accept'), { tries: 160 })
  await pause(page, 2200)
  await shot(page, 'diff')
  await clickButtonText(page, 'Accept')
  await pause(page, 1500)
  await clickButtonText(page, 'Run')
  await waitFor(page, () => document.body.innerText.includes('Exited'), { tries: 60 })
  await pause(page, 1800)

  // 4. Library and playgrounds
  await clickTitle(page, 'Question library')
  await pause(page, 2200)
  await shot(page, 'library')
  await clickTitle(page, 'Playgrounds')
  await pause(page, 1800)
  await shot(page, 'playgrounds')
  await clickTitle(page, 'Workspace')
  await pause(page, 1500)

  const video = page.video()
  await app.close()
  const src = video ? await video.path() : null
  if (src) fs.copyFileSync(src, path.join(OUT_DIR, 'demo.webm'))
  fs.rmSync(USER_DATA, { recursive: true, force: true })
  console.log(`done — ${OUT_DIR}`)
}

main().catch((err) => {
  console.error('RECORD CRASHED:', err)
  process.exit(1)
})
