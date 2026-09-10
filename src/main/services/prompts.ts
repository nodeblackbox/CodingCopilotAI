import type { AskRequest, ChipRequest, InlineCompleteRequest } from '@shared/types'
import { EDITOR_CMD } from '@shared/types'

const CHIP_INSTRUCTIONS: Record<ChipRequest['chipId'], string> = {
  explain:
    'Explain what this problem is asking in plain terms, in 3-5 sentences. Do not propose a solution.',
  hints:
    'Give a nudge toward the right approach without revealing the full solution or writing code. One or two sentences, Socratic in tone.',
  ideaMap:
    'List 2-4 candidate approaches from naive to optimal, each as one line: name — complexity — one-sentence tradeoff. No code.',
  generate:
    'Write a complete, correct, efficient solution to this problem in the given language. Return ONLY the full source code for the file, nothing else — no markdown fences, no commentary.',
  addTests:
    'Suggest 3-5 additional test cases (including edge cases) as "input -> expected output" lines. No code.',
  lint: 'Review the current code for style and naming issues. Be specific and brief. No rewritten code, just notes.',
  complete:
    'The code has a function signature/imports in place but an incomplete or missing body. Return ONLY the full completed source code for the file, nothing else — no markdown fences, no commentary.',
  optimize:
    'Rewrite the current code to be more time/space efficient while staying correct. Return ONLY the full replacement source code for the file, nothing else — no markdown fences, no commentary.',
  checkLogic:
    'Check the current code for correctness bugs (off-by-one, wrong base case, mutation issues, etc). Point out anything wrong, or confirm it looks correct and why. No rewritten code.',
  related:
    'List 3-5 related problems that use the same pattern, as a plain list of titles only, one per line.'
}

export function buildChipPrompt(req: ChipRequest): { system: string; user: string } {
  const system = [
    'You are an interview-prep coding copilot embedded in an IDE, in the style of a LeetCode AI assistant.',
    'Be concise, concrete, and never pad your answer with filler. Match the requested output format exactly.',
    `The current problem is "${req.questionTitle}":`,
    req.questionPrompt
  ].join('\n')

  const user = [
    CHIP_INSTRUCTIONS[req.chipId],
    '',
    `Language: ${req.language}`,
    'Current editor contents:',
    '```',
    req.code || '(empty)',
    '```'
  ].join('\n')

  return { system, user }
}

/** The file with line numbers and a ▶ on the cursor line, so the model can talk about "line 4" and insert precisely. */
function renderEditor(req: AskRequest): string[] {
  const lines = (req.code || '').split('\n')
  const cur = req.cursor
  const width = String(lines.length).length
  const body = lines.map((l, i) => {
    const n = i + 1
    const mark = cur && cur.line === n ? '▶' : ' '
    return `${String(n).padStart(width)}${mark}| ${l}`
  })
  const out = ['Editor (line numbers are not part of the file; ▶ marks the cursor line):', '```', ...body, '```']
  if (cur) out.push(`Cursor: line ${cur.line}, column ${cur.column}.`)
  if (req.selection?.trim()) out.push('Selected text:', '```', req.selection, '```')
  return out
}

export function buildAskSystemPrompt(req: AskRequest): string {
  const base = [
    'You are an interview-prep coding copilot living inside the candidate\'s IDE. They already know how to code and',
    'want to speedrun interview patterns. Be direct and concise. You can SEE their editor, cursor and selection below,',
    'and you can TYPE into it (see "Editing the file").',
    `Current problem: "${req.questionTitle}"`,
    req.questionPrompt,
    `Language: ${req.language}`,
    ...renderEditor(req),
    '',
    'Editing the file',
    `- When the candidate asks you to write, type, insert, add, or print something into the editor, put the exact code in a block:`,
    `  ${EDITOR_CMD.insert}`,
    '  <code to insert at the cursor, already indented for that spot; end with a newline when it is a whole line>',
    `  ${EDITOR_CMD.end}`,
    `- To rewrite the whole file (they will see a diff and accept or reject), use ${EDITOR_CMD.replace} … ${EDITOR_CMD.end} with the full file.`,
    '- At most one block per reply. Outside the block, say in one short sentence what you did. Never read code aloud.',
    '- Only do this when asked (or when they clearly want the code typed). Otherwise coach in words.',
    '- If their code is wrong, say so plainly and point at the line number.'
  ]

  if (req.spoken) {
    base.push(
      '',
      'VOICE MODE: your reply (outside any code block) is read aloud by text-to-speech and the candidate is talking to you.',
      'Answer in 1-3 short spoken sentences. No markdown, no bullet lists, no symbols that sound wrong when read out',
      '(say "big O of n", not "O(n)"). Code goes only inside an INSERT/REPLACE block, never in the spoken text.'
    )
  }

  if (req.guidedVoice) {
    base.push(
      '',
      'GUIDED MODE IS ON: never dump the full solution.',
      'Give exactly ONE next instruction (a single step: "add a for loop over...", "now check if the complement is in the map").',
      'Keep it to 1-2 sentences, then stop and wait for the candidate to say they have done it before giving the next step.',
      'If they ask you to type the step for them, insert just that one step with an INSERT block.'
    )
  } else if (!req.spoken) {
    base.push('', 'You may include short code snippets in markdown when they genuinely help explain; use INSERT/REPLACE when they want it in the editor.')
  }

  return base.join('\n')
}

/** Ghost-text completion at the cursor. The model must return only the text to insert. */
export function buildInlinePrompt(req: InlineCompleteRequest): { system: string; user: string } {
  const system = [
    `You are a code completion engine (like GitHub Copilot) for ${req.language}, helping solve "${req.questionTitle}".`,
    'You will be shown the code before the cursor and the code after it. Output ONLY the text that should be',
    'inserted at the cursor to continue the code naturally: no explanation, no markdown fences, no repetition of',
    'the text before the cursor. Usually finish the current line and add at most a few more lines. Preserve the',
    'indentation style. If nothing sensible should be inserted, output nothing.',
    ...(req.conversation
      ? [
          '',
          'The user has been talking with their coach about this code. Let that intent steer the suggestion (e.g. if they',
          'just agreed to use a hash map, suggest the hash-map step, not the brute-force one):',
          req.conversation
        ]
      : [])
  ].join('\n')

  const user = `<before_cursor>\n${req.prefix}\n</before_cursor>\n<after_cursor>\n${req.suffix}\n</after_cursor>`
  return { system, user }
}
