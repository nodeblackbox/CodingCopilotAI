// UI-level check of what the copilot DOES in the editor (typed chat, so no microphone needed).
// Needs `npm run build` and an AI key in .env. Throwaway profile: your settings/logs are untouched.
//   node scripts/copilot-ui-check.mjs
import { _electron as electron } from 'playwright-core'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-ui-profile-'))
const SHOT_DIR = path.join(os.tmpdir(), 'prep-copilot-ui')
fs.mkdirSync(SHOT_DIR, { recursive: true })
const electronBin = path.join(APP_DIR, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) failures++
}

const CODE = [
  'class Solution:',
  '    def twoSum(self, nums, target):',
  '        for i in range(len(nums)):',
  '            for j in range(i + 1, len(nums)):',
  '                print(nums[i])',
  '                print(nums[j])',
  '',
  'print(Solution().twoSum([2, 7, 11, 15], 9))'
].join('\n')

const editorText = (page) =>
  page.evaluate(() => [...document.querySelectorAll('.view-line')].map((e) => e.textContent).join('\n').replace(/ /g, ' '))
const caret = (page) => page.evaluate(() => document.querySelector('[data-testid="caret-readout"]')?.textContent ?? '')
const lastAssistant = (page) =>
  page.evaluate(() => {
    const bubbles = [...document.querySelectorAll('.justify-start > div')]
    return bubbles.length ? bubbles[bubbles.length - 1].textContent : ''
  })

async function say(page, text) {
  await page.click('[data-testid="chat-input"]')
  await page.fill('[data-testid="chat-input"]', text)
  await page.click('[data-testid="chat-send"]')
  // wait for the reply to finish (Stop button disappears) or a local action to land
  await page.waitForTimeout(600)
  for (let i = 0; i < 60; i++) {
    if (!(await page.$('[data-testid="stop-reply"]'))) break
    await page.waitForTimeout(500)
  }
  await page.waitForTimeout(400)
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
  // no ghost text during this check (it would race with the edits)
  await page.evaluate(async () => {
    const s = await window.api.store.getSettings()
    await window.api.store.setSettings({ ...s, inlineCompletions: false, helpStyle: 'coach', autoApplyEdits: true })
  })
  await page.reload()
  await page.waitForSelector('.monaco-editor', { timeout: 15_000 })
  await page.waitForTimeout(1200)

  // put known code in the editor
  await page.click('.monaco-editor .view-lines')
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  // paste (typing would let Monaco auto-indent every line a second time)
  await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), CODE)
  await page.keyboard.press('Control+V')
  await page.waitForTimeout(300)
  const start = await editorText(page)
  check('editor holds the test code', start.replace(/\s+$/, '') === CODE.replace(/\s+$/, ''), JSON.stringify(start))

  await page.click('[data-testid="mode-ask"]')
  await page.waitForTimeout(300)

  // help-style switcher is there and coach is selected
  const coachOn = await page.evaluate(() => document.querySelector('[data-testid="help-style-coach"]')?.className.includes('teal') ?? false)
  check('help style selector shows Coach', coachOn)

  // spoken-style number navigation, no model call
  await say(page, 'go to line four')
  check('"go to line four" moves the caret (local, digits not required)', /Ln 4\b/.test(await caret(page)), await caret(page))

  // a real deletion, through the model + LINES block
  await say(page, 'Remove line 5 and line 6. You do it.')
  const afterDelete = await editorText(page)
  check('"remove line 5 and 6" deletes them', !afterDelete.includes('print(nums[i])') && !afterDelete.includes('print(nums[j])') && afterDelete.includes('for j in range'), JSON.stringify(afterDelete))
  check('the edit note is shown', /deleted lines? 5/.test(await lastAssistant(page)), await lastAssistant(page))
  await page.screenshot({ path: path.join(SHOT_DIR, '01-after-delete.png') })

  const undoBtn = await page.$('[data-testid="undo-ai-edit"]')
  check('Undo AI edit is offered', Boolean(undoBtn))
  if (undoBtn) {
    await undoBtn.click()
    await page.waitForTimeout(400)
    const restored = await editorText(page)
    check('Undo brings the lines back', restored.includes('print(nums[i])') && restored.includes('print(nums[j])'), JSON.stringify(restored))
  }

  // "um, wait" is not answered
  const before = await page.evaluate(() => document.querySelectorAll('.justify-start > div').length)
  await say(page, 'Um, wait, give me a second')
  const after = await page.evaluate(() => document.querySelectorAll('.justify-start > div').length)
  check('"um, wait, give me a second" gets no reply', after === before, `${before} → ${after}`)

  // "run it" presses Run locally
  await say(page, 'run it')
  await page.waitForTimeout(2500)
  const term = await page.evaluate(() => document.body.innerText)
  check('"run it" runs the code', /Exited \d+ in \d+ms/.test(term))

  await page.screenshot({ path: path.join(SHOT_DIR, '02-end.png') })
  await app.close()
  fs.rmSync(PROFILE, { recursive: true, force: true })
  console.log(failures ? `\n${failures} FAILED — screenshots in ${SHOT_DIR}` : `\nALL PASSED — screenshots in ${SHOT_DIR}`)
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error('copilot-ui-check crashed:', err)
  process.exit(2)
})
