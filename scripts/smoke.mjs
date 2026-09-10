// End-to-end smoke test: launches the BUILT app (run `npm run build` first) under Playwright,
// then drives the real UI through the real IPC paths:
//   1. four-column workspace renders with Monaco
//   2. Run executes the starter Python locally and prints to the console drawer
//   3. Ask mode sends one message to the configured AI provider (needs a key in .env)
//   4. Agent mode "Optimize solution" produces an in-editor diff; Accept applies it to Monaco
// Screenshots land in <os tmp>/prep-smoke/. Usage: npm run smoke
import { _electron as electron } from 'playwright-core'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(os.tmpdir(), 'prep-smoke')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const electronBin = path.join(
  APP_DIR,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron'
)

let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) failures++
}

const shot = (page, name) => page.screenshot({ path: path.join(SHOT_DIR, name + '.png') })
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
async function waitFor(page, predicate, { tries = 90, every = 500 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (await page.evaluate(predicate)) return true
    await page.waitForTimeout(every)
  }
  return false
}

async function main() {
  const app = await electron.launch({ executablePath: electronBin, args: [APP_DIR], timeout: 30_000 })

  // firstWindow() can race against the auto-opened DevTools pane; wait for the real app window.
  let page = null
  for (let i = 0; i < 50 && !page; i++) {
    page = app.windows().find((w) => w.url().startsWith('file://'))
    if (!page) await new Promise((r) => setTimeout(r, 200))
  }
  if (!page) throw new Error('app window never appeared')
  await page.waitForLoadState('domcontentloaded')
  await page.waitForSelector('.monaco-editor', { timeout: 15_000 })
  await page.waitForTimeout(1000)

  // 1. layout
  const body = await page.evaluate(() => document.body.innerText)
  check('workspace renders question', body.includes('Two Sum'))
  check('copilot panel renders', body.includes('AI Copilot'))
  check('Monaco mounted', await page.evaluate(() => !!document.querySelector('.monaco-editor')))
  await shot(page, '01-workspace')

  // 2. real Python run
  check('Run button clicked', await clickButtonText(page, 'Run'))
  const ran = await waitFor(page, () => document.body.innerText.includes('Exited'), { tries: 40 })
  const consoleText = await page.evaluate(() => document.body.innerText)
  check('Python executed locally', ran && consoleText.includes('[0, 1]'), ran ? '' : 'no "Exited" line')
  await shot(page, '02-after-run')

  // 3. Ask mode → real provider call, streamed
  check('switched to Ask', await clickTestId(page, 'mode-ask'))
  await page.waitForTimeout(300)
  await page.evaluate(() => {
    const ta = document.querySelector('[data-testid="chat-input"]')
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(
      ta,
      'In two short sentences, what pattern solves this problem and why?'
    )
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
  check('send clicked', await clickTestId(page, 'chat-send'))
  // Streaming: the assistant bubble should grow over time rather than appear all at once.
  const growth = []
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250)
    const len = await page.evaluate(() => {
      const b = document.querySelectorAll('.max-w-\\[90\\%\\]')
      return b.length >= 3 ? b[2].textContent.length : 0
    })
    growth.push(len)
    const done = await page.evaluate(() => !document.querySelector('[data-testid="stop-reply"]'))
    if (len > 0 && done) break
  }
  const distinct = new Set(growth.filter((n) => n > 0)).size
  const bubbles = await page.evaluate(() => [...document.querySelectorAll('.max-w-\\[90\\%\\]')].map((e) => e.textContent))
  const reply = bubbles[2] ?? ''
  check('AI replied without error', reply.length > 0 && !reply.includes('Copilot error'), reply.slice(0, 120))
  check('reply was streamed incrementally', distinct >= 2, `${distinct} distinct lengths observed: ${growth.filter(Boolean).slice(0, 8).join(',')}…`)
  await shot(page, '03-after-ask')

  // 3a. Editor command: ask the copilot to type at the cursor; the code must land in Monaco and NOT in the bubble.
  await page.evaluate(() => {
    const ta = document.querySelector('[data-testid="chat-input"]')
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(
      ta,
      'Please type a one-line Python comment that says "hash map goes here" at my cursor. Do not change anything else.'
    )
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
  check('command message sent', await clickTestId(page, 'chat-send'))
  // Monaco renders spaces as NBSP inside .view-lines — normalise before matching.
  const inserted = await waitFor(
    page,
    () => !document.querySelector('[data-testid="stop-reply"]') && /hash map goes here/i.test((document.querySelector('.view-lines')?.innerText ?? '').replace(/ /g, ' ')),
    { tries: 60 }
  )
  const ownLine = await page.evaluate(() => {
    const lines = (document.querySelector('.view-lines')?.innerText ?? '').replace(/ /g, ' ').split('\n')
    const i = lines.findIndex((l) => /hash map goes here/i.test(l))
    return i >= 0 && !/class Solution/.test(lines[i])
  })
  check('inserted comment sits on its own line (not glued to existing code)', ownLine)
  const cmdBubble = await page.evaluate(() => {
    const b = document.querySelectorAll('.max-w-\\[90\\%\\]')
    return b[b.length - 1]?.textContent ?? ''
  })
  check('copilot typed into the editor on request', inserted, cmdBubble.slice(0, 100))
  check('command block hidden from the reply', !cmdBubble.includes('<<<') && !/hash map goes here/.test(cmdBubble.replace(/_\(.*?\)_/, '')), cmdBubble.slice(0, 100))
  const lnCol = await page.evaluate(() => document.body.innerText.match(/Ln \d+, Col \d+/)?.[0] ?? '')
  check('copilot header shows the caret position', /Ln \d+, Col \d+/.test(lnCol), lnCol)
  await shot(page, '03a-command-insert')

  // 3b. Inline completion IPC (ghost text itself is Monaco UI; we exercise the request path directly)
  const inline = await page.evaluate(() =>
    window.api.ai.inlineComplete({
      language: 'python',
      questionTitle: 'Two Sum',
      prefix: 'class Solution:\n    def twoSum(self, nums: list[int], target: int) -> list[int]:\n        seen = {}\n        for i, num in enumerate(nums):\n            complement = ',
      suffix: '\n        return []'
    })
  )
  check('inline completion returned code', /target|num/.test(inline.text), JSON.stringify(inline.text.slice(0, 60)))

  // 3c. Playgrounds: "New playground" must hand out a different question
  const before = await page.evaluate(() => document.body.innerText.match(/\d+\. ([^\n]+)/)?.[1] ?? '')
  await page.evaluate(() => [...document.querySelectorAll('button[title="Playgrounds"]')][0]?.click())
  await page.waitForTimeout(300)
  check('New playground clicked', await clickTestId(page, 'new-playground'))
  await page.waitForTimeout(800)
  const after = await page.evaluate(() => document.body.innerText.match(/\d+\. ([^\n]+)/)?.[1] ?? '')
  check('new playground opened a different question', Boolean(after) && after !== before, `${before} → ${after}`)
  await shot(page, '03c-new-playground')
  // back to Two Sum for the diff test (Optimize needs the brute-force starter)
  await page.evaluate(() => [...document.querySelectorAll('button[title="Question library"]')][0]?.click())
  await page.waitForTimeout(300)
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('div')].find((d) => d.textContent?.trim().startsWith('1.Two Sum') || d.textContent?.trim().startsWith('1. Two Sum'))
    const open = row && [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Open')
    open?.click()
  })
  await page.waitForTimeout(500)
  const backOnTwoSum = await page.evaluate(() => document.body.innerText.includes('1. Two Sum'))
  check('library Open switched back to Two Sum', backOnTwoSum)

  // 3d. Voice sidecar starts from the app (mic itself needs a real audio device; not driven here)
  const voiceState = await page.evaluate(() => window.api.voice.start())
  check('voice sidecar started from Electron', voiceState.status === 'ready' && voiceState.port > 0, JSON.stringify(voiceState))
  // 3d-bis. The renderer must be allowed (CSP!) to open the WebSocket to that port and get "ready".
  const wsReady = await page.evaluate(
    (port) =>
      new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`)
        const t = setTimeout(() => resolve({ ok: false, why: 'timeout' }), 8000)
        ws.onerror = () => { clearTimeout(t); resolve({ ok: false, why: 'onerror (CSP or refused)' }) }
        ws.onmessage = (e) => { clearTimeout(t); const m = JSON.parse(e.data); ws.close(); resolve({ ok: m.type === 'ready', why: `${m.type} stt=${m.stt} turn=${m.turn}` }) }
      }),
    voiceState.port
  )
  check('renderer can open the voice WebSocket', wsReady.ok, wsReady.why)
  await page.evaluate(() => window.api.voice.stop())

  // 3e. OS voices available to the instant "webspeech" engine
  const voices = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const list = () => speechSynthesis.getVoices().map((v) => v.name)
        if (list().length) return resolve(list())
        speechSynthesis.onvoiceschanged = () => resolve(list())
        setTimeout(() => resolve(list()), 3000)
      })
  )
  // Informational: Electron on Windows may expose no speechSynthesis voices at all (then the "webspeech" engine is moot).
  console.log(`INFO  speechSynthesis voices: ${voices.length}${voices.length ? ` — Ava? ${voices.some((v) => /ava/i.test(v))} — ${voices.slice(0, 4).join(', ')}` : ' (Edge TTS via the sidecar is the working path)'}`)

  // 4. Agent mode → diff → Accept
  check('switched to Agent', await clickTestId(page, 'mode-agent'))
  await page.waitForTimeout(300)
  check('Optimize clicked', await clickButtonText(page, 'Optimize solution'))
  const diffReady = await waitFor(
    page,
    () =>
      [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Accept') &&
      [...document.querySelectorAll('span.w-3.flex-none')].some((s) => s.textContent === '+')
  )
  const counts = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('span.w-3.flex-none')]
    return { add: spans.filter((s) => s.textContent === '+').length, del: spans.filter((s) => s.textContent === '−').length }
  })
  check('diff rendered with additions', diffReady && counts.add > 0, JSON.stringify(counts))
  await shot(page, '04-diff')
  await clickButtonText(page, 'Accept')
  await page.waitForTimeout(1500)
  const editorText = await page.evaluate(() => document.querySelector('.view-lines')?.innerText ?? '')
  check('Accept applied code to Monaco', /seen|enumerate|complement/.test(editorText))
  await shot(page, '05-after-accept')

  await app.close()
  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'} — screenshots in ${SHOT_DIR}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('SMOKE TEST CRASHED:', err)
  process.exit(1)
})
