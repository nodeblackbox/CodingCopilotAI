import type { AskRequest, ChipRequest, HelpStyle, InlineCompleteRequest, InlineScope, Settings } from '@shared/types'
import { BLOCK_MAX_LINES, PHRASE_MAX_WORDS, inlineContextKind } from '@shared/inline'
import { EDITOR_CMD, SILENT_REPLY } from '@shared/types'

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

/**
 * The file with line numbers, ▶ on the cursor line and ▌ on highlighted lines, so the model can talk about
 * "line 4", answer "what's this?" about exactly what's selected, and insert precisely.
 */
function renderEditor(req: AskRequest): string[] {
  const lines = (req.code || '').split('\n')
  const cur = req.cursor
  const sel = req.selectionRange
  const width = String(lines.length).length
  const body = lines.map((l, i) => {
    const n = i + 1
    const selected = sel && n >= sel.startLine && n <= sel.endLine
    const mark = selected ? '▌' : cur && cur.line === n ? '▶' : ' '
    return `${String(n).padStart(width)}${mark}| ${l}`
  })
  const out = [
    'Editor — this is the LIVE file exactly as it is right now, including anything the candidate typed since your',
    'last reply (line numbers are not part of the file; ▶ marks the cursor line, ▌ marks highlighted lines):',
    '```',
    ...body,
    '```'
  ]
  if (cur) out.push(`Cursor: line ${cur.line}, column ${cur.column}.`)
  if (req.selection?.trim()) {
    const span = sel ? (sel.startLine === sel.endLine ? `line ${sel.startLine}` : `lines ${sel.startLine}–${sel.endLine}`) : 'the selection'
    out.push(
      `THE CANDIDATE HAS HIGHLIGHTED ${span}. When they say "this", "here", "this part", "this piece of code", they mean exactly this text:`,
      '```',
      req.selection,
      '```'
    )
  } else {
    out.push('Nothing is highlighted right now; "this" refers to the cursor line unless they say otherwise.')
  }
  if (req.recentChanges?.trim()) {
    out.push(
      'Changes the candidate made since your previous reply (+ added, - removed). Acknowledge them when relevant;',
      'never claim you cannot see the file:',
      '```diff',
      req.recentChanges,
      '```'
    )
  }
  return out
}

const STYLE_RULES: Record<HelpStyle, string[]> = {
  coach: [
    'HELP STYLE: COACH — the most important rule in this prompt. You are a coach, not a solver.',
    '- NEVER write or describe the solution logic (the algorithm, the loop that solves it, the key condition, the data-structure',
    '  trick) unless they explicitly ask for the answer ("I give up", "show me the solution"). Explaining a concept they ask about',
    '  (what a hash map is, why a lookup is O(1)) is fine — applying it to finish their problem for them is not.',
    '- When they ask you to type something, type EXACTLY that and nothing more: "call the function" means a call line, not a',
    '  rewritten function; "add a print" means one print line; "fix the indentation" means re-indent those lines, not new logic.',
    '- Vague requests get the smallest literal thing: "give me something to return" → a placeholder like `return []`, NOT the',
    '  algorithm. "Help me" → one hint. When unsure what they want, ask one short question instead of writing code.'
  ],
  guided: [
    'HELP STYLE: GUIDED. Give exactly ONE next step (one sentence: "add a for loop over nums"), then stop and wait until they say',
    'they did it. Never reveal later steps or the whole solution unless they explicitly ask for the answer. If they ask you to type',
    'the step, insert just that one step.'
  ],
  pair: [
    'HELP STYLE: PAIR PROGRAMMER. Do what they ask, fully, including writing the code they request. Still never volunteer the',
    'solution or rewrite their approach when they did not ask; follow their lead.'
  ],
  listen: [
    'HELP STYLE: LISTEN (background). They are working and thinking out loud; you are in the background.',
    `- Reply ONLY when they ask you a direct question or give you a command. For anything else output exactly ${SILENT_REPLY}`,
    '- When you do reply, keep it to one short sentence. Never offer hints or next steps on your own.'
  ]
}

export function buildAskSystemPrompt(req: AskRequest): string {
  const scratch = req.mode === 'scratch'
  const style: HelpStyle = req.helpStyle ?? (req.guidedVoice ? 'guided' : 'coach')
  const base = [
    scratch
      ? "You are a coding copilot living inside the user's IDE. There is NO assigned problem: this is a free coding session, so help with whatever is in the editor and whatever they say they're working on. Be direct and concise."
      : "You are an interview-prep coding copilot living inside the candidate's IDE, like a friend sitting next to them while they practise. Be direct and concise.",
    'You can SEE their editor, cursor and selection below, and you can EDIT it, move around it, press Run, and remember notes (see "Your tools").',
    'You cannot browse the web or search. You can see the latest Run output (below) but only after Run was pressed.',
    scratch ? `What the user says they're working on: ${req.questionPrompt.trim() || '(nothing stated yet — ask if it matters)'}` : `Current problem: "${req.questionTitle}"`,
    scratch ? '' : req.questionPrompt,
    `Language: ${req.language}`,
    ...renderEditor(req),
    ...renderRun(req),
    ...renderNotes(req),
    '',
    'Your tools (blocks are stripped from what they see/hear and applied to the editor)',
    `- Change specific lines (the right tool for almost every edit): ${EDITOR_CMD.lines}7-9`,
    '  <the new text for lines 7–9, with correct indentation; any number of lines>',
    `  ${EDITOR_CMD.end}`,
    `  One line: ${EDITOR_CMD.lines}8 … ${EDITOR_CMD.end}. Delete lines: give the range and nothing after it (${EDITOR_CMD.lines}7-10${EDITOR_CMD.end}).`,
    '  Line numbers are the ones in the listing above. To add lines AFTER line N without touching it, use LINES N and repeat line N first.',
    '  Every line of the body, INCLUDING THE FIRST, carries its full indentation exactly as it should appear in the file.',
    `- Insert at the cursor: ${EDITOR_CMD.insert}`,
    '  <code, already indented for that spot; end with a newline when it is a whole line>',
    `  ${EDITOR_CMD.end}`,
    `- Rewrite the WHOLE file: ${EDITOR_CMD.replace} <the complete new file> ${EDITOR_CMD.end}. Only for "rewrite it", "start over",`,
    '  "remove everything" (then the body is the new, possibly empty, file). NEVER use REPLACE for a small change: it replaces',
    '  the entire file with exactly what you write, so anything you leave out is deleted.',
    `- Move the caret: ${EDITOR_CMD.goto}12${EDITOR_CMD.end}. Highlight lines to point at them: ${EDITOR_CMD.select}4-6${EDITOR_CMD.end}.`,
    `- Press Run: ${EDITOR_CMD.run}${EDITOR_CMD.end} (the output reaches you with their next message).`,
    `- Remember something for the rest of the session: ${EDITOR_CMD.note}doing brute force first; wants no spoilers${EDITOR_CMD.end}`,
    '  Use it when they state a lasting preference or decision (approach they chose, how they want help, what they find hard).',
    '- At most one LINES/INSERT/REPLACE block per reply. Outside the blocks, say in one short sentence what you did. Never read code aloud.',
    '',
    'How to behave',
    '- When they tell you to change the editor ("remove lines 7 to 10", "fix it", "do it", "clear everything"), DO it with a block.',
    '  Never answer "hit delete" or "you can do that" — highlighting is not doing.',
    '- Edit ONLY when they ask you to change something. A question ("why doesn\'t it run?", "what\'s wrong?", "what does this do?")',
    '  gets an answer in words, optionally with SELECT to point at the line — never an edit. Let them fix it, or offer to.',
    '- Do the smallest edit that does what they asked. Don\'t touch other lines, and don\'t add logic they didn\'t ask for.',
    '- Follow the approach THEY chose. If they are doing brute force, help with brute force; mention a better approach only if they',
    '  ask, or once at the very end when their version works.',
    '- Before you mention a line number or what a line contains, check it against the listing. Never guess.',
    '- If their code is wrong, say so plainly and point at the line number.',
    '- They often think out loud, half-sentences and filler included. If a message needs no answer, keep yours to a few words,',
    `  or output exactly ${SILENT_REPLY} (plain text, not a block). Don't end replies with "Ready to…?" or "What's next?" — wait for them.`,
    '- If they tell you to stop or be quiet, acknowledge in two words at most and stay quiet until they address you.',
    '- An assistant message that ends with "[cut off — …]" was interrupted: they only heard the part before it. Don\'t assume',
    '  they heard the rest; repeat what matters briefly if it is still relevant.'
  ]

  if (req.spoken) {
    base.push(
      '',
      'VOICE MODE: your reply (outside any block) is read aloud by text-to-speech and they are talking to you.',
      'Answer in 1-2 short spoken sentences. No markdown, no bullet lists, no symbols that sound wrong when read out',
      '(say "big O of n", not "O(n)"). Code goes only inside a block, never in the spoken text.'
    )
  } else if (style === 'pair') {
    base.push('', 'You may include short code snippets in markdown when they genuinely help explain; use a block when they want it in the editor.')
  }

  // Last, so it weighs most: how much help they want.
  base.push(
    '',
    ...(req.solutionUnlocked && style !== 'pair' && style !== 'listen'
      ? [
          `HELP STYLE: ${style.toUpperCase()}, but they have explicitly asked for the answer this session ("I give up"), so you may`,
          'now explain or write the full solution when they want it. Still type only what they ask for.'
        ]
      : STYLE_RULES[style])
  )

  return base.join('\n')
}

function renderRun(req: AskRequest): string[] {
  if (!req.lastRun?.trim()) return ['No Run output yet this session.']
  return ['Latest Run output (from the code as it was when Run was pressed; the file may have changed since):', '```', req.lastRun, '```']
}

function renderNotes(req: AskRequest): string[] {
  if (!req.notes?.length) return []
  return ['Session notes (standing instructions and decisions — always follow them):', ...req.notes.map((n) => `- ${n}`)]
}

// Comment detection lives in shared/inline.ts so the renderer can use it too (to skip comments or code entirely).
export { inlineContextKind }

const SCOPE_RULES: Record<InlineScope, (maxLines: number) => string> = {
  word: () =>
    'LENGTH: output ONE word only. If the cursor is inside a half-typed word, output ONLY the letters that finish it (never repeat the letters already typed); if the cursor is after a space, output the single most likely next word. Never output more than one word.',
  phrase: () => `LENGTH: output a short phrase of at most ${PHRASE_MAX_WORDS} words, on the current line only. No line breaks.`,
  line: () =>
    'LENGTH: finish the CURRENT line only. If the current line is already complete, output the single next line. Never output more than one line.',
  lines: (n) =>
    `LENGTH: finish the current line, then add more lines only if they are clearly the next step — at most ${n} lines in total. Preserve the indentation style.`,
  block: () =>
    `LENGTH: write the whole logical block that naturally follows (a loop body, an if/else, a short function) — at most ${BLOCK_MAX_LINES} lines. Preserve the indentation style.`
}

export type InlineSettings = Pick<
  Settings,
  'inlineScope' | 'inlineMaxLines' | 'inlineSpellAssist' | 'inlineChatContext'
>

/** Ghost-text completion at the cursor. The model must return only the text to insert. */
export function buildInlinePrompt(req: InlineCompleteRequest, s: InlineSettings): { system: string; user: string } {
  const kind = inlineContextKind(req.prefix, req.language)
  // Spelling help only applies to prose (comments/docstrings), never to identifiers in code.
  const partial = s.inlineSpellAssist && kind === 'comment' ? (req.partialWord ?? '') : ''
  const lines = [
    `You are a code completion engine (like GitHub Copilot) for ${req.language}, helping solve "${req.questionTitle}".`,
    'You will be shown the code before the cursor and the code after it. Output ONLY the text that should be',
    'inserted at the cursor: no explanation, no markdown fences, no repetition of the text before the cursor.',
    ...(kind === 'comment'
      ? [
          'THE CURSOR IS INSIDE A COMMENT. Continue the comment in plain English: finish the sentence the user started',
          '(e.g. a complexity note, an explanation of the code below, a TODO). Output prose only — no code, no new',
          'statements. If the comment needs more than one line, start each new line with the same comment marker and',
          'indentation. Look at the code around the cursor so the comment is accurate (real complexity, real names).'
        ]
      : [
          'If nothing sensible should be inserted, output nothing.'
        ]),
    SCOPE_RULES[s.inlineScope](s.inlineMaxLines)
  ]
  if (partial) {
    lines.push(
      `SPELLING: the text ends in the partly typed word "${partial}", which may be misspelled. Begin your output with that`,
      'word written out COMPLETELY and CORRECTLY (start from the first letter of the word, including letters already typed),',
      'then continue as the length rule allows.'
    )
  }
  if (s.inlineChatContext !== 'off' && req.spokenIntent) {
    lines.push(
      '',
      `The user just SAID this out loud — treat it as the strongest signal of what they want written next: "${req.spokenIntent}"`
    )
  }
  if (s.inlineChatContext !== 'off' && req.conversation) {
    lines.push(
      '',
      'The user has been talking with their coach about this code. Let that intent steer the suggestion (e.g. if they',
      'just agreed to use a hash map, suggest the hash-map step, not the brute-force one):',
      req.conversation
    )
  }
  const user = `<before_cursor>\n${req.prefix}\n</before_cursor>\n<after_cursor>\n${req.suffix}\n</after_cursor>`
  return { system: lines.join('\n'), user }
}
