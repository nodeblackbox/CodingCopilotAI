/**
 * Ghost-text (inline completion) rules shared by main (prompt + hard trimming) and the renderer (settings UI,
 * deciding whether to ask at all). Pure functions only, so they're unit-testable with `node --test`.
 */
import type { InlineScope, Settings } from './types'

/** How much a suggestion may contain. Enforced twice: asked for in the prompt, then hard-trimmed here. */
export const INLINE_SCOPES: ReadonlyArray<{ id: InlineScope; label: string; hint: string }> = [
  { id: 'word', label: 'Word', hint: 'Finish the word you are typing, or predict the next word. Best for spelling help.' },
  { id: 'phrase', label: 'Phrase', hint: 'Up to ~6 words — the rest of a short phrase or expression.' },
  { id: 'line', label: 'Line', hint: 'Finish the current line (or write the next one when the line is done).' },
  { id: 'lines', label: 'Few lines', hint: 'Up to the max-lines setting. The classic Copilot feel.' },
  { id: 'block', label: 'Block', hint: 'A whole function / loop body (up to ~25 lines).' }
]

export const BLOCK_MAX_LINES = 25
export const PHRASE_MAX_WORDS = 6

/**
 * Visible-output size → token budget. gpt-oss is a reasoning model and its hidden reasoning tokens count against
 * max_tokens: with a tight budget it spends everything thinking and returns "" (the old flat 160 hit its cap on a
 * large share of calls). So: a fixed headroom for reasoning on top of what the visible text needs. The result is
 * still hard-trimmed to the scope, so the headroom costs a little latency, never longer suggestions.
 */
const REASONING_HEADROOM = 300

export function inlineMaxTokens(scope: InlineScope, maxLines: number): number {
  switch (scope) {
    case 'word':
      return REASONING_HEADROOM + 16
    case 'phrase':
      return REASONING_HEADROOM + 32
    case 'line':
      return REASONING_HEADROOM + 48
    case 'lines':
      return REASONING_HEADROOM + Math.max(1, maxLines) * 30
    case 'block':
      return REASONING_HEADROOM + BLOCK_MAX_LINES * 25
  }
}

/**
 * Lines of code sent around the caret, by scope. A word or a line needs far less context than a block, and every
 * prompt token counts against Groq's 8,000-tokens-per-minute free-tier limit — so small scopes send small prompts
 * (faster, and far fewer silent rate-limit misses while typing).
 */
export const INLINE_CONTEXT: Record<InlineScope, { before: number; after: number }> = {
  word: { before: 20, after: 6 },
  phrase: { before: 20, after: 6 },
  line: { before: 30, after: 10 },
  lines: { before: 50, after: 20 },
  block: { before: 80, after: 30 }
}

/** Preset colours for the ghost text; `default` is a neutral white so it works on any theme. */
export const GHOST_COLORS: Record<string, { label: string; hex: string }> = {
  default: { label: 'Neutral', hex: '#ffffff' },
  teal: { label: 'Teal', hex: '#2dd4bf' },
  amber: { label: 'Amber', hex: '#fbbf24' },
  violet: { label: 'Violet', hex: '#a78bfa' },
  rose: { label: 'Rose', hex: '#fb7185' }
}

/**
 * Is the caret inside a comment or docstring? Then the completion should be prose, not code.
 * Cheap heuristics over the text before the cursor; good enough for #, //, /* … *\/ and Python triple quotes.
 */
export function inlineContextKind(prefix: string, language: string): 'comment' | 'code' {
  const line = prefix.slice(prefix.lastIndexOf('\n') + 1)
  const t = line.trimStart()
  if (/^(#|\/\/|\*|\/\*|--|<!--)/.test(t)) return 'comment'
  // trailing comment on a code line: `x = 1  # because`
  // (an odd number of quotes before the marker means the marker is inside a string literal, not a comment)
  const insideString = (before: string): boolean => ((before.match(/"/g) ?? []).length % 2 === 1) || ((before.match(/'/g) ?? []).length % 2 === 1)
  const py = language === 'python' ? line.match(/(^|\s)#[^'"]*$/) : null
  if (py && !insideString(line.slice(0, py.index! + py[0].length - py[0].trimStart().length))) return 'comment'
  const slashes = language !== 'python' ? line.match(/(^|\s)\/\/[^'"]*$/) : null
  if (slashes && !insideString(line.slice(0, slashes.index! + slashes[0].length - slashes[0].trimStart().length))) return 'comment'
  // inside an unclosed block comment or docstring
  const lastOpen = prefix.lastIndexOf('/*')
  if (lastOpen >= 0 && prefix.indexOf('*/', lastOpen) < 0) return 'comment'
  if (language === 'python') {
    const triple = (prefix.match(/"""|'''/g) ?? []).length
    if (triple % 2 === 1) return 'comment'
  }
  return 'code'
}

/**
 * Some models answer a multi-line completion as ONE line with literal backslash-n sequences between statements.
 * If there is no real newline at all and a literal \n is followed by indentation, it was a flattened line break
 * (a genuine string escape like "a\n" is not followed by 2+ spaces), so restore it.
 */
export function restoreFlattenedNewlines(text: string): string {
  if (text.includes('\n') || !/\\n[ \t]{2,}/.test(text)) return text
  return text.replace(/\\n/g, '\n')
}

/** The partially typed word right before the cursor ("recie" in "# we recie"), or ''. */
export function partialWordBefore(prefix: string): string {
  return prefix.match(/[A-Za-z][A-Za-z']*$/)?.[0] ?? ''
}

/**
 * Hard cap on what a suggestion may contain, regardless of what the model sent. A leading newline (the model
 * suggesting the NEXT line) is preserved for line/lines/block scopes.
 */
export function limitInline(text: string, scope: InlineScope, maxLines: number): string {
  if (!text) return text
  if (scope === 'word') {
    // optional single leading space, then one token
    const m = text.match(/^[ \t]?\S+/)
    return m ? m[0] : ''
  }
  if (scope === 'phrase') {
    const firstLine = text.split('\n')[0]
    const parts = firstLine.match(/\s*\S+/g) ?? []
    return parts.slice(0, PHRASE_MAX_WORDS).join('').replace(/\s+$/, '')
  }
  const lines = text.split('\n')
  const cap = scope === 'line' ? 1 : scope === 'lines' ? Math.max(1, maxLines) : BLOCK_MAX_LINES
  if (lines[0] === '') {
    // starts with a newline: the suggestion is whole new line(s); the empty first segment doesn't count
    return ('\n' + lines.slice(1, 1 + cap).join('\n')).replace(/\s+$/, '')
  }
  return lines.slice(0, cap).join('\n').replace(/\s+$/, '')
}

/**
 * Turn a model answer for a partially-typed word into what Monaco should show.
 * - answer starts with the partial (case-insensitive): insert only the remainder at the cursor.
 * - otherwise (a misspelling being corrected): replace the typed fragment with the whole answer.
 */
export function resolvePartialWord(
  answer: string,
  partial: string
): { insertText: string; replacePartial: boolean } {
  if (!partial) return { insertText: answer, replacePartial: false }
  if (answer.toLowerCase().startsWith(partial.toLowerCase())) {
    return { insertText: answer.slice(partial.length), replacePartial: false }
  }
  // Model returned only a continuation ("ive" after "rece")? Detect: does not look like a word start for this fragment.
  const firstWord = answer.match(/^[A-Za-z']+/)?.[0] ?? ''
  if (!firstWord) return { insertText: answer, replacePartial: false }
  return { insertText: answer, replacePartial: true }
}

/** Voice-command parsing for ghost text: "ghost text off", "ghost text one line", "ghost text comments only". */
export interface GhostCommand {
  patch: Partial<{
    inlineCompletions: boolean
    inlineScope: InlineScope
    inlineInCode: boolean
    inlineInComments: boolean
  }>
  reply: string
}

export function parseGhostCommand(text: string): GhostCommand | null {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ')} `
  // Only unambiguous names for the feature ("predict"/"suggestion" show up in ordinary coding talk), and only short,
  // imperative utterances — never a long sentence that happens to mention ghost text.
  if (!/\b(ghost|inline completions?|autocomplete|auto complete)\b/.test(t)) return null
  if (t.trim().split(' ').length > 12) return null
  if (/\?\s*$/.test(text.trim()) || /^\s*(how|what|why|does|do|is|are|can)\b/.test(t)) return null
  // an imperative verb, or a terse command that leads with the feature name ("ghost text whole block")
  const terse = /^\s*(ok |okay |hey |now )?(ghost|inline completions?|autocomplete|auto complete)\b/.test(t)
  if (!terse && !/\b(turn|switch|set|make|use|only|just|enable|disable|stop|start|limit|keep)\b/.test(t)) return null
  if (/\b(turn|switch|set)\b.*\boff\b|\b(disable|stop)\b/.test(t)) return { patch: { inlineCompletions: false }, reply: 'Ghost text off.' }
  if (/\b(turn|switch|set)\b.*\bon\b|\b(enable|start)\b/.test(t)) return { patch: { inlineCompletions: true }, reply: 'Ghost text on.' }
  if (/\bcomments?\s+only\b|\bonly\s+(in\s+)?comments?\b/.test(t)) {
    return { patch: { inlineCompletions: true, inlineInCode: false, inlineInComments: true }, reply: 'Ghost text: comments only.' }
  }
  if (/\bcode\s+only\b|\bonly\s+(in\s+)?code\b/.test(t)) {
    return { patch: { inlineCompletions: true, inlineInCode: true, inlineInComments: false }, reply: 'Ghost text: code only.' }
  }
  if (/\b(code and comments|both)\b/.test(t)) {
    return { patch: { inlineCompletions: true, inlineInCode: true, inlineInComments: true }, reply: 'Ghost text: code and comments.' }
  }
  const scopes: Array<[RegExp, InlineScope, string]> = [
    [/\b(words?|spelling)\b/, 'word', 'words'],
    [/\bphrases?\b/, 'phrase', 'phrases'],
    [/\b(one|single|1)\s+line\b|\bline\s+(only|by line)\b|\bjust\s+(the\s+)?line\b/, 'line', 'one line'],
    [/\b(few|several|couple( of)?)\s+lines\b|\blines\b/, 'lines', 'a few lines'],
    [/\b(block|function|whole|entire|everything)\b/, 'block', 'whole blocks']
  ]
  for (const [re, scope, label] of scopes) {
    if (re.test(t)) return { patch: { inlineCompletions: true, inlineScope: scope }, reply: `Ghost text: ${label}.` }
  }
  return null
}

/** Defaults for every ghost-text setting; spread into both DEFAULT_SETTINGS (main + renderer) so they can't drift. */
export const INLINE_DEFAULTS: Pick<
  Settings,
  | 'inlineScope'
  | 'inlineMaxLines'
  | 'inlineInCode'
  | 'inlineInComments'
  | 'inlineTrigger'
  | 'inlineDebounceMs'
  | 'inlineChatContext'
  | 'inlineSpellAssist'
  | 'ghostOpacity'
  | 'ghostColor'
  | 'ghostItalic'
> = {
  inlineScope: 'lines',
  inlineMaxLines: 5,
  inlineInCode: true,
  inlineInComments: true,
  inlineTrigger: 'auto',
  inlineDebounceMs: 350,
  inlineChatContext: 'all',
  inlineSpellAssist: true,
  ghostOpacity: 0.4,
  ghostColor: 'default',
  ghostItalic: false
}

/** One-click bundles for the settings screen. Each is a partial patch over the ghost-text settings. */
export const INLINE_PRESETS: ReadonlyArray<{ id: string; label: string; hint: string; patch: Partial<Settings> }> = [
  {
    id: 'copilot',
    label: 'Copilot',
    hint: 'Code and comments, up to a few lines at a time.',
    patch: { inlineCompletions: true, inlineScope: 'lines', inlineMaxLines: 5, inlineInCode: true, inlineInComments: true, inlineTrigger: 'auto' }
  },
  {
    id: 'line',
    label: 'Line by line',
    hint: 'Finishes the current line, never more.',
    patch: { inlineCompletions: true, inlineScope: 'line', inlineInCode: true, inlineInComments: true, inlineTrigger: 'auto' }
  },
  {
    id: 'words',
    label: 'Words & spelling',
    hint: 'One word at a time, in comments only, with spelling correction.',
    patch: { inlineCompletions: true, inlineScope: 'word', inlineInCode: false, inlineInComments: true, inlineSpellAssist: true, inlineTrigger: 'auto' }
  },
  {
    id: 'on-demand',
    label: 'On demand',
    hint: 'Silent until you press Alt+\\ — cheapest and least distracting.',
    patch: { inlineCompletions: true, inlineScope: 'lines', inlineMaxLines: 5, inlineTrigger: 'manual' }
  },
  {
    id: 'voice-led',
    label: 'Voice-led',
    hint: 'Suggestions follow only what you say out loud.',
    patch: { inlineCompletions: true, inlineChatContext: 'voice' }
  }
]
