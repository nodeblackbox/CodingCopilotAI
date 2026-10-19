/**
 * Small spoken-language helpers that let the renderer act on a transcript without a model call:
 * spoken numbers for navigation ("go to line four"), and short utterances that are not really a turn
 * ("shut up", "um, wait", "run it"). Pure functions so they are unit-tested (scripts/voice.test.mjs).
 */

const ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19
}
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }
/** Speech-to-text homophones that only mean a number right after "line" ("go to line for"). */
const AFTER_LINE: Record<string, string> = { for: '4', fore: '4', to: '2', too: '2', won: '1', ate: '8' }

/**
 * "line twenty two" → "line 22", "lines five to nine" → "lines 5 to 9". Only number words become digits;
 * everything else is left as spoken. Meant for parsing, not for what is shown or sent to the model.
 */
export function normalizeSpokenNumbers(text: string): string {
  const tokens = text.split(/(\s+|[,.!?;:]+)/)
  const out: string[] = []
  let prevWord = ''
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    const w = tok.toLowerCase()
    if (/^lines?$/.test(prevWord) && AFTER_LINE[w] !== undefined) {
      out.push(AFTER_LINE[w])
      prevWord = AFTER_LINE[w]
      continue
    }
    let value: number | null = null
    let consumed = i
    if (TENS[w] !== undefined) {
      value = TENS[w]
      // "twenty two" / "twenty-two": look past one whitespace token for a ones word
      const next = tokens[i + 2]?.toLowerCase()
      if (tokens[i + 1] !== undefined && /^\s+$/.test(tokens[i + 1]) && next && ONES[next] !== undefined && ONES[next] < 10 && ONES[next] > 0) {
        value += ONES[next]
        consumed = i + 2
      }
    } else if (/^(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)-(one|two|three|four|five|six|seven|eight|nine)$/.test(w)) {
      const [t, o] = w.split('-')
      value = TENS[t] + ONES[o]
    } else if (ONES[w] !== undefined) {
      value = ONES[w]
    }
    if (value === null) {
      out.push(tok)
      if (/\S/.test(tok) && !/^[,.!?;:]+$/.test(tok)) prevWord = w
      continue
    }
    out.push(String(value))
    prevWord = String(value)
    i = consumed
  }
  return out.join('')
}

export type LocalIntent =
  /** "shut up", "stop talking", "be quiet": stop speaking, no reply, no model call. */
  | 'quiet'
  /** "um", "wait wait", "give me a second": the user is thinking out loud — keep it in the thread, don't answer. */
  | 'hold'
  /** "run it", "run the code": press Run. */
  | 'run'

const LEAD = /^(?:(?:okay|ok|alright|yo|bro|dude|hey|please|just|no|now|and|so|can you|could you|go ahead and)[,\s]+)*/i
const words = (s: string): string[] => s.toLowerCase().replace(/[^a-z' ]+/g, ' ').split(/\s+/).filter(Boolean)

const HOLD_WORDS = new Set(['um', 'uh', 'umm', 'uhh', 'hmm', 'hm', 'erm', 'wait', 'hold', 'hang', 'second', 'sec', 'moment', 'minute', 'think', 'thinking'])
const FILLER_WORDS = new Set([
  ...HOLD_WORDS, 'on', 'give', 'me', 'a', 'one', 'let', 'just', 'okay', 'ok', 'so', 'bro', 'my', 'bad', 'oh', 'ah', 'yeah', 'right', 'mm',
  'like', 'i', 'need', 'to', 'up', 'please', 'sorry', 'actually', 'the', 'it', 'gimme', 'lemme', 'tight', 'quick', 'wa'
])

/**
 * Utterances the app answers itself. Deliberately narrow: anything with real content ("yes", "wait, why is
 * line 4 wrong?") still goes to the model.
 */
export function localIntent(text: string): LocalIntent | null {
  const t = text.trim()
  if (!t || /\?\s*$/.test(t)) return null
  const w = words(t)
  if (!w.length || w.length > 8) return null
  const body = t.replace(LEAD, '')
  if (/^(?:shut up|be quiet|quiet|stop talking|stop it|stop|enough|silence|hush|zip it|pipe down)(?:[,\s]+(?:please|now|bro|man|dude|talking|for a (?:sec|second|bit|moment)))*[.!]*$/i.test(body)) return 'quiet'
  if (/^(?:run|execute)(?: it| this| that| the code| my code| the program)?(?: (?:please|again|now|for me|quickly))*[.!]?$/i.test(body)) return 'run'
  if (w.every((x) => FILLER_WORDS.has(x)) && w.some((x) => HOLD_WORDS.has(x))) return 'hold'
  return null
}

/** "remove everything", "clear it all", "start fresh": a request that legitimately empties most of the file. */
export function wantsClearFile(text: string): boolean {
  return /\b(?:remove|delete|clear|wipe|erase|get rid of|empty)\b[^.?!]*\b(?:everything|all of it|it all|whole (?:thing|file)|entire (?:thing|file)|all the code|the file)\b|\bclean slate\b|\bstart (?:over|fresh|from scratch)\b/i.test(
    text
  )
}

/** "I give up", "just show me the answer": unlocks the full solution in coach/guided styles. */
export function wantsSolution(text: string): boolean {
  const m = /\b(?:i give up|i'm giving up|give me the (?:answer|solution)|show me the (?:answer|solution|full solution)|just (?:tell|show) me the (?:answer|solution)|reveal the (?:answer|solution)|write the (?:whole|full|entire) solution)\b/i.exec(
    text
  )
  if (!m) return false
  // "don't give me the answer" / "never show me the solution" is the opposite request
  return !/\b(?:don'?t|do not|never|not|stop)\s+(?:\w+\s+){0,2}$/i.test(text.slice(0, m.index))
}
