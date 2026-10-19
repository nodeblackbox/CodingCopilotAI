#!/usr/bin/env node
// Read per-run session logs without opening them raw.
//   npm run logs -- list
//   npm run logs -- summary [latest|<id-prefix>]
//   npm run logs -- errors  [session]
//   npm run logs -- turns   [session] [--last N]
//   npm run logs -- voice   [session] [--around <ms-since-start>] [--window <s>]
//   npm run logs -- grep <cat|ev|text> [session] [--limit N]
// `turns` reads the conversation file (logs/conversations/<id>.jsonl); the rest read the session file.
// Output is capped on purpose; pass --limit to widen it. Set PREP_LOG_DIR to point elsewhere.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dir =
  process.env.PREP_LOG_DIR ||
  join(
    process.env.APPDATA || (process.platform === 'darwin' ? join(homedir(), 'Library/Application Support') : join(homedir(), '.config')),
    'prep-copilot',
    'logs',
    'sessions'
  )

const args = process.argv.slice(2)
const flags = {}
const pos = []
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true
  else pos.push(args[i])
}
const cmd = pos[0] || 'list'
const limit = Number(flags.limit) || 60

function sessions() {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
  } catch {
    return []
  }
}

function readJsonl(path) {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return { cat: 'log', ev: 'unparsable', data: l.slice(0, 200) }
        }
      })
  } catch {
    return []
  }
}

/** The conversation file shares the session's id: logs/conversations/<id>.jsonl next to logs/sessions/. */
function loadConvo(file) {
  return readJsonl(join(dir, '..', 'conversations', file))
}

function load(name) {
  const files = sessions()
  if (!files.length) die(`No session logs in ${dir}. Run the app once first.`)
  let file
  if (!name || name === 'latest') file = files[files.length - 1]
  else file = files.find((f) => f.startsWith(name)) || files.find((f) => f.includes(name))
  if (!file) die(`No session matching "${name}". Try: npm run logs -- list`)
  const events = readJsonl(join(dir, file))
  return { file, events, convo: loadConvo(file) }
}

function die(msg) {
  console.error(msg)
  process.exit(1)
}

const clip = (s, n = 160) => {
  s = typeof s === 'string' ? s : JSON.stringify(s)
  return s && s.length > n ? s.slice(0, n) + '…' : s
}
const secs = (ms) => (ms / 1000).toFixed(1).padStart(7) + 's'
const isErr = (e) => e.level === 'error' || e.cat === 'error'
const isWarn = (e) => e.level === 'warn'
const line = (e) => `${secs(e.ms ?? 0)}  ${e.cat}/${e.ev}${e.level ? ` [${e.level}]` : ''}  ${clip(e.data)}`
const capped = (rows, n = limit) => {
  rows.slice(0, n).forEach((r) => console.log(r))
  if (rows.length > n) console.log(`… ${rows.length - n} more (use --limit)`)
}

function dedupe(events) {
  const m = new Map()
  for (const e of events) {
    const key = `${e.cat}/${e.ev}: ${clip(e.data?.message ?? e.data?.name ?? e.data, 100)}`
    const cur = m.get(key) || { n: 0, first: e.ms ?? 0, last: e.ms ?? 0 }
    cur.n++
    cur.last = e.ms ?? 0
    m.set(key, cur)
  }
  return [...m.entries()].map(([k, v]) => `${secs(v.first)}  x${v.n}  ${k}${v.n > 1 ? ` (last ${secs(v.last).trim()})` : ''}`)
}

if (cmd === 'list') {
  const rows = sessions().map((f) => {
    const { events, convo } = load(f)
    const end = events[events.length - 1]?.ms ?? 0
    const n = (fn) => events.filter(fn).length
    return `${f.replace('.jsonl', '').padEnd(26)} ${String(Math.round(end / 1000)).padStart(6)}s  turns=${String(convo.filter((e) => e.ev === 'user').length).padStart(3)}  errors=${String(n(isErr)).padStart(3)}  warns=${String(n(isWarn)).padStart(3)}  ${(statSync(join(dir, f)).size / 1024).toFixed(0)}KB`
  })
  if (!rows.length) die(`No session logs in ${dir}.`)
  capped(rows.reverse(), Number(flags.limit) || 30)
} else if (cmd === 'summary') {
  const { file, events, convo } = load(pos[1])
  const start = events.find((e) => e.ev === 'session_start')
  const end = events[events.length - 1]?.ms ?? 0
  console.log(`# ${file}  (${Math.round(end / 1000)}s, ${events.length} events)`)
  if (start?.data) console.log(`app ${start.data.app} electron ${start.data.electron} dev=${start.data.dev}`)
  const quit = events.some((e) => e.cat === 'app' && e.ev === 'quit')
  if (!quit) console.log('! no clean "quit" event — the app crashed, was killed, or is still running')

  const states = events.filter((e) => e.cat === 'voice' && e.ev === 'state')
  if (states.length) {
    console.log('\n## voice states')
    capped(states.map((e) => `${secs(e.ms)}  ${e.data?.state}${e.data?.reason ? `  (${clip(e.data.reason, 80)})` : ''}`), 40)
  }

  const userTurns = convo.filter((e) => e.ev === 'user')
  const navMisses = convo.filter((e) => e.ev === 'nav_regex_miss')
  console.log(
    `\n## conversation: ${userTurns.length} user turns (${userTurns.filter((e) => e.data?.source === 'voice').length} voice), ` +
      `${convo.filter((e) => e.ev === 'assistant').length} replies, ${convo.filter((e) => e.ev === 'assistant_cancelled').length} cancelled, ` +
      `${convo.filter((e) => e.ev === 'echo_dropped').length} echo drops, ${navMisses.length} nav misses` +
      `\n   ${convo.filter((e) => e.ev === 'cut_off').length} cut off mid-speech, ${convo.filter((e) => e.data?.silent).length} silent replies, ` +
      `${convo.filter((e) => e.ev === 'local_intent').length} handled locally (quiet/hold/run), ${convo.filter((e) => e.ev === 'replace_guarded').length} rewrites held for review, ` +
      `${convo.filter((e) => e.ev === 'auto_apply').length} auto-applied, ${convo.filter((e) => e.ev === 'undo_ai_edit').length} undone`
  )
  const errs = [...events, ...convo].filter((e) => isErr(e) || isWarn(e))
  console.log(`\n## errors/warnings (${errs.length}, deduped)`)
  capped(dedupe(errs), 30)

  const timed = [...events, ...convo]
    .map((e) => ({ e, ms: e.data?.ms ?? e.data?.asrMs ?? e.data?.latencyMs }))
    .filter((x) => typeof x.ms === 'number')
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 8)
  if (timed.length) {
    console.log('\n## slowest operations')
    timed.forEach((x) => console.log(`${String(Math.round(x.ms)).padStart(7)} ms  ${x.e.cat}/${x.e.ev} @${secs(x.e.ms).trim()}`))
  }

  const counts = {}
  for (const e of [...events, ...convo]) counts[`${e.cat}/${e.ev}`] = (counts[`${e.cat}/${e.ev}`] || 0) + 1
  console.log('\n## event counts')
  console.log(
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([k, v]) => `${k}=${v}`)
      .join('  ')
  )
} else if (cmd === 'errors') {
  const { events, convo } = load(pos[1])
  const errs = [...events, ...convo].filter((e) => isErr(e) || isWarn(e)).sort((a, b) => (a.ms ?? 0) - (b.ms ?? 0))
  console.log(`${errs.length} errors/warnings`)
  capped(errs.map(line))
} else if (cmd === 'turns') {
  // The conversation, in order: what the mic heard, what you said, what the assistant said/did.
  const { events, convo } = load(pos[1])
  const heard = events.filter((e) => e.cat === 'stt' && e.ev === 'final')
  const rows = [...convo, ...heard].sort((a, b) => (a.ms ?? 0) - (b.ms ?? 0))
  const label = {
    user: (d) => `YOU [${d.source}]  ${clip(d.text, 400)}`,
    final: (d) => `  heard (asr ${d.asrMs}ms, turn=${d.turn}${d.turnP != null ? ` p=${d.turnP}` : ''})  ${clip(d.text, 200)}`,
    assistant: (d) => `AI   ${clip(d.text, 500)}  [${d.ms}ms${d.firstChunkMs != null ? `, first token ${d.firstChunkMs}ms` : ''}${d.spoken ? ', spoken' : ''}]`,
    assistant_error: (d) => `AI   ERROR ${clip(d.error, 300)}`,
    assistant_cancelled: (d) => `AI   (cancelled: ${d.reason} after ${d.afterMs}ms) ${clip(d.partial, 120)}`,
    speech_cancelled: (d) => `AI   (speech cut: ${d.reason})`,
    nav: (d) => `NAV  "${clip(d.text, 80)}" -> ${clip(d.results, 120)}${d.navOnly ? ' (local only)' : ''}`,
    nav_regex_miss: (d) => `NAV? no pattern matched: "${clip(d.text, 120)}"`,
    editor_cmd: (d) => `EDIT ${d.kind} ${d.arg ?? ''} -> ${clip(d.result, 80)}`,
    editor_cmd_failed: (d) => `EDIT FAILED ${d.kind} ${d.arg ?? ''}`,
    editor_cmd_malformed: (d) => `EDIT MALFORMED opened=${d.opened} applied=${d.applied}`,
    echo_dropped: (d) => `ECHO dropped (${d.overlap}) "${clip(d.heard, 100)}"`,
    continuation_merged: (d) => `MERGE "${clip(d.earlier, 60)}" + "${clip(d.heard, 60)}"`,
    chip: (d) => `CHIP ${d.chipId}  ${clip(d.summary, 200)}`,
    chip_error: (d) => `CHIP ${d.chipId} ERROR ${clip(d.summary, 200)}`,
    diff_accept: () => 'DIFF accepted',
    diff_reject: () => 'DIFF rejected',
    paused: (d) => `PAUSED ${clip(d.reason, 160)}`
  }
  const lines = rows.map((e) => `${secs(e.ms)}  ${(label[e.ev] || ((d) => `${e.ev} ${clip(d, 160)}`))(e.data || {})}`)
  const last = Number(flags.last)
  capped(last ? lines.slice(-last * 3) : lines, Number(flags.limit) || 100)
} else if (cmd === 'voice') {
  const { events } = load(pos[1])
  let rows = events.filter((e) => ['voice', 'stt', 'tts', 'sidecar'].includes(e.cat) || isErr(e))
  if (flags.around) {
    const c = Number(flags.around) * (Number(flags.around) < 100000 ? 1000 : 1)
    const w = (Number(flags.window) || 10) * 1000
    rows = rows.filter((e) => Math.abs((e.ms ?? 0) - c) <= w)
  }
  capped(rows.filter((e) => e.ev !== 'partial').map(line), Number(flags.limit) || 80)
} else if (cmd === 'grep') {
  const q = String(pos[1] || '').toLowerCase()
  if (!q) die('usage: grep <cat|ev|text> [session]')
  const { events } = load(pos[2])
  capped(events.filter((e) => `${e.cat}/${e.ev} ${JSON.stringify(e.data ?? '')}`.toLowerCase().includes(q)).map(line))
} else {
  die('commands: list | summary | errors | turns | voice | grep')
}
