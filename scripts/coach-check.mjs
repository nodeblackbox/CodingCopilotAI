// Real-model check of the copilot's behaviour rules, using situations from a real voice session.
// Needs `npm run build` and an AI key in .env. Uses a THROWAWAY profile, so your settings/logs are untouched.
//   node scripts/coach-check.mjs
import { _electron as electron } from 'playwright-core'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-coach-profile-'))
const electronBin = path.join(APP_DIR, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '\n        ' + detail.replace(/\n/g, '\n        ') : ''}`)
  if (!ok) failures++
}

const TWO_SUM = `Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.`
const BRUTE = [
  'class Solution:',
  '    def twoSum(self, nums, target):',
  '        for i in range(len(nums)):',
  '            for j in range(i + 1, len(nums)):',
  '                print(nums[i])',
  '                print(nums[j])',
  '                if nums[i] + nums[j] == target:',
  '                    print()',
  '',
  'print(Solution().twoSum([2, 7, 11, 15], 9))'
].join('\n')
const EMPTY = ['class Solution:', '    def twoSum(self, nums, target):', '        ', ''].join('\n')

async function ask(page, { text, code = BRUTE, helpStyle = 'coach', history = [], lastRun, notes, spoken = true, solutionUnlocked = false }) {
  return page.evaluate(
    async (r) => {
      const requestId = `chk-${Math.random().toString(36).slice(2)}`
      let raw = ''
      const offChunk = window.api.ai.onStreamChunk((e) => {
        if (e.requestId === requestId) raw += e.delta
      })
      const done = new Promise((resolve) => {
        const off = window.api.ai.onStreamDone((e) => {
          if (e.requestId !== requestId) return
          off()
          resolve(e)
        })
      })
      await window.api.ai.askStream({
        requestId,
        messages: [...r.history, { role: 'user', text: r.text }],
        guidedVoice: r.helpStyle === 'guided',
        helpStyle: r.helpStyle,
        notes: r.notes,
        solutionUnlocked: r.solutionUnlocked,
        lastRun: r.lastRun,
        spoken: r.spoken,
        questionTitle: 'Two Sum',
        questionPrompt: r.prompt,
        mode: 'interview',
        language: 'python',
        code: r.code,
        cursor: { line: 5, column: 1 }
      })
      const end = await done
      offChunk()
      return { raw, error: end.error }
    },
    { text, code, helpStyle, history, lastRun, notes, spoken, solutionUnlocked, prompt: TWO_SUM }
  )
}

const blocks = (raw, kind) => [...raw.matchAll(new RegExp(`<<<${kind}>>>([\\s\\S]*?)<<<END>>>`, 'g'))].map((m) => m[1])
const SOLUTION_HINTS = /seen\s*=\s*\{\}|\{\}\s*$|target\s*-\s*nums|complement|in seen|enumerate\(nums\)|return \[i, j\]/m

async function main() {
  const app = await electron.launch({ executablePath: electronBin, args: [APP_DIR, `--user-data-dir=${PROFILE}`], timeout: 30_000 })
  let page = null
  for (let i = 0; i < 50 && !page; i++) {
    page = app.windows().find((w) => w.url().startsWith('file://'))
    if (!page) await new Promise((r) => setTimeout(r, 200))
  }
  if (!page) throw new Error('app window never appeared')
  await page.waitForSelector('.monaco-editor', { timeout: 15_000 })

  // 1. "make line 8 say bang" — must be a targeted line edit, never a whole-file REPLACE
  let r = await ask(page, { text: 'For the print statement on line 8, make it so that it says bang.' })
  const l1 = blocks(r.raw, 'LINES')
  check('small edit uses LINES, not REPLACE', l1.length === 1 && /^\s*8\b/.test(l1[0]) && /bang/i.test(l1[0]) && !blocks(r.raw, 'REPLACE').length, r.raw)

  // 2. "remove lines 7 to 10" — must actually delete, not highlight and tell them to press delete
  r = await ask(page, { text: 'Remove line 5 and line 6. Bro, you do it.' })
  const l2 = blocks(r.raw, 'LINES')
  check('"remove lines" deletes them with an empty LINES block', l2.length === 1 && /^\s*5\s*(-|–|to)\s*6\s*$/.test(l2[0]), r.raw)

  // 3. coach: "give me something to return" must not hand over the algorithm
  r = await ask(page, { text: 'Wait bro just give me something to return the function', code: EMPTY })
  check('coach: no solution logic for a vague request', !SOLUTION_HINTS.test(r.raw), r.raw)

  // 4. coach: user chose brute force earlier (note) — the reply must not push the hash map
  r = await ask(page, { text: 'What do I check inside the inner loop?', notes: ['Candidate is doing the brute-force approach first'] })
  check('follows the chosen approach (no hash map push)', !/hash ?map|dictionary|complement/i.test(r.raw.replace(/<<<[\s\S]*?<<<END>>>/g, '')), r.raw)

  // 5. listen: thinking out loud gets "(silent)"
  r = await ask(page, { text: "Okay so I'm gonna loop over this and then I think I compare the two numbers", helpStyle: 'listen' })
  // the renderer treats "(silent)" and "<<<SILENT>>>" alike
  check('listen: no reply to thinking out loud', /^(\(silent\)|<<<silent>>>)\.?$/i.test(r.raw.trim()), r.raw)

  // 6. listen: a direct question still gets an answer
  r = await ask(page, { text: 'What is the time complexity of two nested loops?', helpStyle: 'listen' })
  check('listen: direct question answered', r.raw.trim().length > 10 && !/\(silent\)/i.test(r.raw), r.raw)

  // 7. sees the Run output
  // 7. sees the Run output — and a question gets an answer, not an unrequested edit
  const BROKEN = BRUTE.replace('                print(nums[i])', '            print(nums[i])')
  r = await ask(page, {
    text: "Why doesn't it run?",
    code: BROKEN,
    lastRun: '$ python solution.py\nstderr:   File "solution.py", line 5\nstderr:     print(nums[i])\nstderr:     ^\nstderr: IndentationError: expected an indented block after \'for\' statement on line 4\nExited 1 in 194ms'
  })
  check('uses the Run output (indentation error)', /indent/i.test(r.raw) && !/can'?t (see|run)/i.test(r.raw), r.raw)
  check('a question gets words, not an edit', !/<<<(LINES|INSERT|REPLACE)>>>/.test(r.raw), r.raw)

  // 8. "I give up" unlocks the answer
  // (the renderer sets solutionUnlocked when it hears "I give up"; this calls main directly, so pass it)
  r = await ask(page, { text: 'Okay I give up, show me the solution and type it in.', code: EMPTY, helpStyle: 'coach', solutionUnlocked: true })
  check('"I give up": solution is written', /<<<(INSERT|REPLACE|LINES)>>>/.test(r.raw) && /return/.test(r.raw), r.raw.slice(0, 400))

  await app.close()
  fs.rmSync(PROFILE, { recursive: true, force: true })
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error('coach-check crashed:', err)
  process.exit(2)
})
