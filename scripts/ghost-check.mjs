// Real-app check of the ghost-text feature (run `npm run build` first; needs a Groq or Anthropic key in .env).
// Uses a THROWAWAY profile (--user-data-dir) so it never touches your real settings or logs.
//   node scripts/ghost-check.mjs
import { _electron as electron } from 'playwright-core'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const SHOT_DIR = path.join(os.tmpdir(), 'prep-ghost')
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-ghost-profile-'))
fs.mkdirSync(SHOT_DIR, { recursive: true })
const electronBin = path.join(APP_DIR, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) failures++
}
const click = (page, testid) =>
  page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`)
    if (!el) return false
    el.click()
    return true
  }, testid)
const setSelect = (page, testid, value) =>
  page.evaluate(
    ([id, v]) => {
      const el = document.querySelector(`[data-testid="${id}"]`)
      if (!el) return false
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      setter.call(el, v)
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    },
    [testid, value]
  )
const goto = (page, title) => page.evaluate((t) => [...document.querySelectorAll(`button[title="${t}"]`)][0]?.click(), title)
const ghostText = (page) =>
  page.evaluate(() => [...document.querySelectorAll('.ghost-text-decoration, .ghost-text-decoration-preview, .ghost-text')].map((e) => e.textContent).join('|'))

/** Type into Monaco and wait for ghost text to appear (or time out). */
async function typeAndWait(page, text, { clear = true, waitMs = 9000 } = {}) {
  await page.click('.monaco-editor .view-lines')
  if (clear) {
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Delete')
  }
  await page.keyboard.type(text, { delay: 25 })
  const t0 = Date.now()
  while (Date.now() - t0 < waitMs) {
    const g = await ghostText(page)
    if (g) return g
    await page.waitForTimeout(250)
  }
  return ''
}

async function main() {
  const app = await electron.launch({ executablePath: electronBin, args: [APP_DIR, `--user-data-dir=${PROFILE}`], timeout: 30_000 })
  let page = null
  for (let i = 0; i < 50 && !page; i++) {
    page = app.windows().find((w) => w.url().startsWith('file://'))
    if (!page) await new Promise((r) => setTimeout(r, 200))
  }
  if (!page) throw new Error('app window never appeared')
  await page.waitForSelector('.monaco-editor', { timeout: 15_000 })
  await page.waitForTimeout(1200)

  // --- settings UI: presets, controls, persistence ---------------------------------------------------------------
  await goto(page, 'Settings')
  await page.waitForSelector('[data-testid="ghost-settings"]')
  check('ghost settings section renders', true)
  await click(page, 'ghost-preset-words')
  await page.waitForTimeout(400)
  check('preset "Words & spelling" sets scope=word', (await page.evaluate(() => document.querySelector('[data-testid="ghost-scope-setting"]').value)) === 'word')
  await click(page, 'ghost-color-amber')
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(SHOT_DIR, '01-settings.png'), fullPage: true })
  await page.locator('[data-testid="ghost-settings"]').screenshot({ path: path.join(SHOT_DIR, '01b-ghost-settings.png') })
  await page.waitForTimeout(600) // let the debounced save land
  const saved = JSON.parse(fs.readFileSync(path.join(PROFILE, 'settings.json'), 'utf8'))
  check('settings persisted to disk (debounced)', saved.inlineScope === 'word' && saved.inlineInCode === false && saved.ghostColor === 'amber', JSON.stringify({ s: saved.inlineScope, c: saved.inlineInCode, col: saved.ghostColor }))

  // --- server side: scope enforced on what comes back ------------------------------------------------------------
  const base = { language: 'python', questionTitle: 'Two Sum', suffix: '' }
  const code = 'def two_sum(nums, target):\n    seen = {}\n    for i, n in enumerate(nums):\n        '
  const setScope = (patch) =>
    page.evaluate(async (p) => {
      const cur = await window.api.store.getSettings()
      await window.api.store.setSettings({ ...cur, inlineCompletions: true, inlineInCode: true, inlineInComments: true, ...p })
    }, patch)
  await setScope({ inlineScope: 'word' })
  const w = await page.evaluate((r) => window.api.ai.inlineComplete(r), { ...base, prefix: code + 'comp', partialWord: 'comp' })
  check('scope=word never returns more than one token', w.text === '' || /^[ \t]?\S+$/.test(w.text), JSON.stringify(w.text))
  // reliability: gpt-oss spends hidden reasoning tokens, so a tight budget returns "" — measure how often that happens
  const probes = ['comp', 'seen', 'for i in ra', 'ret', 'nums']
  const outs = []
  for (const tail of probes) outs.push((await page.evaluate((r) => window.api.ai.inlineComplete(r), { ...base, prefix: code + tail, partialWord: tail.match(/[A-Za-z]+$/)?.[0] })).text)
  const filled = outs.filter((t) => t.length > 0).length
  check('scope=word is reliably non-empty (>=3 of 5)', filled >= 3, JSON.stringify(outs))
  await setScope({ inlineScope: 'line' })
  const l = await page.evaluate((r) => window.api.ai.inlineComplete(r), { ...base, prefix: code })
  check('scope=line returns at most one line', l.text.split('\n').filter((x) => x.trim()).length <= 1, JSON.stringify(l.text))
  await setScope({ inlineScope: 'lines', inlineMaxLines: 2 })
  const m = await page.evaluate((r) => window.api.ai.inlineComplete(r), { ...base, prefix: code })
  check('scope=lines respects max lines (2)', m.text.split('\n').length <= 2, JSON.stringify(m.text))
  await setScope({ inlineScope: 'lines', inlineMaxLines: 5, inlineInComments: false })
  const c = await page.evaluate((r) => window.api.ai.inlineComplete(r), { ...base, prefix: code + '# this is' })
  check('comments disabled → no request/suggestion in a comment', c.text === '', JSON.stringify(c.text))
  await setScope({ inlineInComments: true, inlineInCode: false })
  const k = await page.evaluate((r) => window.api.ai.inlineComplete(r), { ...base, prefix: code })
  check('code disabled → no suggestion in code', k.text === '', JSON.stringify(k.text))
  const spell = await (async () => {
    await setScope({ inlineScope: 'word', inlineInCode: true, inlineSpellAssist: true })
    let r = { text: '' }
    // a reasoning model occasionally returns nothing; a few attempts distinguish "flaky" from "broken"
    for (let i = 0; i < 3 && !r.text; i++) {
      r = await page.evaluate((x) => window.api.ai.inlineComplete(x), { ...base, prefix: code + '# we need to recie', partialWord: 'recie' })
      if (!r.text) await page.waitForTimeout(1500)
    }
    return r
  })()
  check('spelling help: "recie" → a corrected word', /receive|recieve|receiv/i.test(spell.text), JSON.stringify(spell.text))

  // --- editor: real ghost text in Monaco, with the saved look ---------------------------------------------------
  // Reload so the renderer picks up what the API calls above wrote.
  await page.reload()
  await page.waitForSelector('.monaco-editor', { timeout: 15_000 })
  await page.waitForTimeout(1500)
  await setScope({ inlineScope: 'lines', inlineMaxLines: 5, inlineInCode: true, inlineInComments: true, inlineTrigger: 'auto', ghostColor: 'amber', ghostItalic: true, ghostOpacity: 0.8 })
  await page.reload()
  await page.waitForSelector('.monaco-editor', { timeout: 15_000 })
  await page.waitForTimeout(1500)

  const g1 = await typeAndWait(page, 'def two_sum(nums, target):\n    seen = {}\n    for i, n in enumerate(nums):\n        comp')
  check('ghost text appears while typing code', g1.length > 0, JSON.stringify(g1.slice(0, 80)))
  await page.screenshot({ path: path.join(SHOT_DIR, '02-ghost-code.png') })
  const style = await page.evaluate(() => {
    const el = document.querySelector('.ghost-text-decoration, .ghost-text-decoration-preview, .ghost-text')
    if (!el) return null
    const cs = getComputedStyle(el)
    return { color: cs.color, fontStyle: cs.fontStyle }
  })
  check('ghost text uses the chosen look (italic + amber)', style?.fontStyle === 'italic' && /251, ?191, ?36/.test(style?.color ?? ''), JSON.stringify(style))

  await page.keyboard.press('Enter')
  // a misspelling can't be ghost text (Monaco never inserts before the caret), so the fix arrives in the suggestion popup
  await page.keyboard.type('# we need to recie', { delay: 25 })
  let g2 = ''
  for (let i = 0; i < 36 && !g2; i++) {
    g2 = await page.evaluate(() => [...document.querySelectorAll('.suggest-widget.visible .monaco-list-row')].map((e) => e.textContent).join('|'))
    await page.waitForTimeout(250)
  }
  check('spelling: misspelled word gets a correction in the popup', /receive/i.test(g2), JSON.stringify(g2.slice(0, 80)))
  if (g2) {
    await page.keyboard.press('Tab')
    await page.waitForTimeout(300)
    const lineText = (await page.evaluate(() => [...document.querySelectorAll('.view-line')].map((e) => e.textContent).join('\n'))).replace(/\u00a0/g, ' ')
    check('Tab applies the correction (recie -> receive)', /need to receive/.test(lineText) && !/recie\b/.test(lineText), JSON.stringify(lineText.split('\n').pop()))
    if (!/need to receive/.test(lineText) || /recie\b/.test(lineText)) console.log('  full editor text:', JSON.stringify(lineText))
  }
  await page.screenshot({ path: path.join(SHOT_DIR, '03-ghost-spelling.png') })
  if (!g2) {
    // Show what the renderer asked/received so a failure is diagnosable (events come from the session log).
    await page.waitForTimeout(400)
    const dir = path.join(PROFILE, 'logs', 'sessions')
    const f = fs.readdirSync(dir).sort().pop()
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => l.includes('inline_spell'))
    console.log('  inline_spell events:', lines.slice(-3).map((l) => JSON.stringify(JSON.parse(l).data)).join('\n    ') || '(none — request never sent?)')
  }

  // Manual trigger: nothing on typing, something after Alt+\
  await setScope({ inlineTrigger: 'manual' })
  await page.reload()
  await page.waitForSelector('.monaco-editor', { timeout: 15_000 })
  await page.waitForTimeout(1500)
  const gm = await typeAndWait(page, 'def two_sum(nums, target):\n    seen = {}\n    for i, n in enumerate(nums):\n        comp', { waitMs: 3500 })
  check('manual mode: no ghost text while typing', gm === '', JSON.stringify(gm))
  await page.keyboard.press('Alt+\\')
  let gm2 = ''
  for (let i = 0; i < 30 && !gm2; i++) {
    gm2 = await ghostText(page)
    await page.waitForTimeout(300)
  }
  check('manual mode: Alt+\\ produces a suggestion', gm2.length > 0, JSON.stringify(gm2.slice(0, 80)))

  const actions = await page.evaluate(() => (window.__prepActions ?? null))
  void actions
  await app.close()
  fs.rmSync(PROFILE, { recursive: true, force: true })
  console.log(failures ? `\n${failures} FAILED — screenshots in ${SHOT_DIR}` : `\nALL PASSED — screenshots in ${SHOT_DIR}`)
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error('ghost-check crashed:', err)
  process.exit(2)
})
