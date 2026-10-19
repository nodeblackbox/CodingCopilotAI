import { useEffect, useRef, useState } from 'react'
import Editor, { type Monaco, type OnMount } from '@monaco-editor/react'
import type { IDisposable, editor as MonacoEditor } from 'monaco-editor'
import { Play, Sparkles, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/Button'
import { DiffPanel } from './DiffPanel'
import { TerminalDrawer } from './TerminalDrawer'
import { recentSpokenIntent, useAppStore } from '@renderer/state/store'
import { attachEditor, readEditorState } from '@renderer/lib/editorBridge'
import { slog } from '@renderer/lib/sessionLog'
import { EDITOR_THEME, applyGhostStyle } from '@renderer/lib/ghostStyle'
import { INLINE_CONTEXT, INLINE_SCOPES, inlineContextKind, partialWordBefore, resolvePartialWord } from '@shared/inline'
import type { InlineScope, Settings } from '@shared/types'

const LANGUAGES = [
  { id: 'python', label: 'Python' },
  { id: 'sql', label: 'SQL' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'java', label: 'Java' },
  { id: 'cpp', label: 'C++' }
]

const MONACO_LANGUAGE: Record<string, string> = {
  python: 'python',
  sql: 'sql',
  javascript: 'javascript',
  java: 'java',
  cpp: 'cpp'
}

const FILE_EXT: Record<string, string> = {
  python: 'py',
  sql: 'sql',
  javascript: 'js',
  java: 'java',
  cpp: 'cpp'
}

/** Ghost-text telemetry, rolled up once a minute so a typing session doesn't flood the log (errors are logged individually). */
const inlineStats = { requests: 0, shown: 0, empty: 0, stale: 0, skipped: 0, errors: 0, msTotal: 0, msMax: 0, chars: 0 }
function flushInlineStats(): void {
  if (!inlineStats.requests && !inlineStats.skipped) return
  const s = useAppStore.getState().settings
  slog('ai', 'inline_stats', {
    ...inlineStats,
    msAvg: inlineStats.requests ? Math.round(inlineStats.msTotal / inlineStats.requests) : 0,
    msTotal: undefined,
    scope: s.inlineScope,
    trigger: s.inlineTrigger
  })
  Object.assign(inlineStats, { requests: 0, shown: 0, empty: 0, stale: 0, skipped: 0, errors: 0, msTotal: 0, msMax: 0, chars: 0 })
}
setInterval(flushInlineStats, 60_000)

const CONVERSATION_TURNS = 6

/** Bumped per keystroke; a request that finishes after a newer one started is thrown away. */
let inlineSeq = 0

/**
 * A spelling fix waiting to be offered. Monaco never draws ghost text that inserts characters BEFORE the caret,
 * and correcting "recie" → "receive" must do exactly that — so a correction is shown in the suggestion popup
 * instead (Tab accepts it, replacing what was typed). Correct prefixes ("rece" → "ive") stay ordinary ghost text.
 */
let pendingSpell: { uri: string; line: number; startCol: number; endCol: number; typed: string; fix: string } | null = null

/** Keep the user's capitalisation: "Recie" → "Receive", "RECIE" → "RECEIVE". */
function matchCase(word: string, typed: string): string {
  if (typed.length > 1 && typed === typed.toUpperCase()) return word.toUpperCase()
  if (typed[0] && typed[0] === typed[0].toUpperCase() && typed[0] !== typed[0].toLowerCase()) return word[0].toUpperCase() + word.slice(1)
  return word
}

/**
 * The last few turns, so ghost text follows what the user and the coach just agreed on. Honors the
 * "conversation context" setting: nothing, only turns that were spoken aloud, or the whole thread.
 */
function recentConversation(mode: Settings['inlineChatContext']): string {
  if (mode === 'off') return ''
  return useAppStore
    .getState()
    .messages.filter((m) => mode === 'all' || m.source === 'voice')
    .slice(-CONVERSATION_TURNS)
    .map((m) => `${m.role === 'user' ? 'user' : 'coach'}: ${m.text.replace(/\s+/g, ' ').slice(0, 300)}`)
    .join('\n')
}

/**
 * Copilot-style ghost text. Monaco calls provideInlineCompletions on every edit; we debounce, ship the
 * code around the cursor (plus the recent conversation) to main, and hand back one suggestion.
 * Tab accepts it — that's Monaco's built-in inline-suggest UX, nothing custom here. What it may contain
 * (word … block), where it appears (code / comments), when it fires (auto / Alt+\) and how it reads the
 * conversation are all user settings; main enforces the length again with a hard trim.
 */
function registerInlineCompletions(monaco: Monaco, editor: MonacoEditor.IStandaloneCodeEditor): IDisposable[] {
  const provider = {
    provideInlineCompletions: async (
      model: MonacoEditor.ITextModel,
      position: import('monaco-editor').Position,
      ctx: { triggerKind: number },
      token: import('monaco-editor').CancellationToken
    ) => {
      const s = useAppStore.getState().settings
      if (!s.inlineCompletions) return { items: [] }
      const explicit = ctx.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit
      if (s.inlineTrigger === 'manual' && !explicit) return { items: [] }
      const seq = ++inlineSeq
      if (!explicit) {
        await new Promise((r) => setTimeout(r, s.inlineDebounceMs))
        if (token.isCancellationRequested || seq !== inlineSeq) return { items: [] }
      }

      const ctxLines = INLINE_CONTEXT[s.inlineScope]
      const lastLine = Math.min(model.getLineCount(), position.lineNumber + ctxLines.after)
      const prefix = model.getValueInRange({
        startLineNumber: Math.max(1, position.lineNumber - ctxLines.before),
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column
      })
      const suffix = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: position.column,
        endLineNumber: lastLine,
        endColumn: model.getLineMaxColumn(lastLine)
      })
      if (!prefix.trim()) return { items: [] }

      const language = model.getLanguageId()
      const kind = inlineContextKind(prefix, language)
      if (kind === 'comment' ? !s.inlineInComments : !s.inlineInCode) {
        inlineStats.skipped++
        return { items: [] }
      }
      // The half-typed word under the caret (needed by main to drop an echo, and for spelling help in prose).
      const typed = partialWordBefore(prefix)
      const partial = typed.length >= 2 ? typed : ''
      const spelling = s.inlineSpellAssist && kind === 'comment' && Boolean(partial)

      const t0 = performance.now()
      let res: { text: string }
      inlineStats.requests++
      try {
        res = await window.api.ai.inlineComplete({
          language,
          prefix,
          suffix,
          questionTitle: useAppStore.getState().question.title,
          conversation: recentConversation(s.inlineChatContext),
          spokenIntent: s.inlineChatContext === 'off' ? undefined : recentSpokenIntent() || undefined,
          partialWord: partial || undefined
        })
      } catch (err) {
        inlineStats.errors++
        slog('ai', 'inline_error', { message: (err as Error).message }, 'error')
        return { items: [] }
      }
      const ms = Math.round(performance.now() - t0)
      inlineStats.msTotal += ms
      inlineStats.msMax = Math.max(inlineStats.msMax, ms)
      if (token.isCancellationRequested || seq !== inlineSeq) {
        inlineStats.stale++
        return { items: [] }
      }
      if (!res.text) {
        inlineStats.empty++
        if (spelling) slog('ai', 'inline_spell', { partial, answer: '', note: 'model returned nothing', ms })
        return { items: [] }
      }
      const { insertText, replacePartial } = spelling ? resolvePartialWord(res.text, partial) : { insertText: res.text, replacePartial: false }
      if (replacePartial) {
        // A genuine misspelling: queue the correction for the suggestion popup (see pendingSpell).
        const word = insertText.match(/^[A-Za-z']+/)?.[0] ?? ''
        if (word && word.toLowerCase() !== partial.toLowerCase()) {
          pendingSpell = {
            uri: model.uri.toString(),
            line: position.lineNumber,
            startCol: position.column - partial.length,
            endCol: position.column,
            typed: partial,
            fix: matchCase(word, partial)
          }
          inlineStats.shown++
          slog('ai', 'inline_spell', { partial, fix: pendingSpell.fix, ms, via: 'suggest-popup' })
          editor.trigger('prep', 'editor.action.triggerSuggest', {})
        } else {
          inlineStats.empty++
        }
        return { items: [] }
      }
      if (spelling) slog('ai', 'inline_spell', { partial, answer: res.text.slice(0, 80), insertText: insertText.slice(0, 80), replacePartial, ms, via: 'ghost' })
      if (!insertText) {
        inlineStats.empty++
        return { items: [] }
      }
      inlineStats.shown++
      inlineStats.chars += insertText.length
      return {
        items: [
          {
            insertText,
            range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column)
          }
        ]
      }
    },
    freeInlineCompletions: () => {}
  }
  // The suggestion-popup half of spelling help: offers exactly one item, the queued correction, and only while the
  // caret still sits at the end of the misspelled word.
  const spellProvider = {
    provideCompletionItems: (model: MonacoEditor.ITextModel, position: import('monaco-editor').Position) => {
      const p = pendingSpell
      if (!p || p.uri !== model.uri.toString() || p.line !== position.lineNumber || p.endCol !== position.column) return { suggestions: [] }
      const range = new monaco.Range(p.line, p.startCol, p.line, p.endCol)
      if (model.getValueInRange(range) !== p.typed) return { suggestions: [] }
      return {
        suggestions: [
          {
            label: p.fix,
            kind: monaco.languages.CompletionItemKind.Text,
            insertText: p.fix,
            filterText: p.typed,
            sortText: '!',
            preselect: true,
            detail: `Spelling: “${p.typed}” → “${p.fix}” (Tab)`,
            range
          }
        ]
      }
    }
  }
  const langs = Object.values(MONACO_LANGUAGE)
  return [
    ...langs.map((lang) => monaco.languages.registerInlineCompletionsProvider(lang, provider)),
    ...langs.map((lang) => monaco.languages.registerCompletionItemProvider(lang, spellProvider))
  ]
}

export function EditorColumn() {
  const language = useAppStore((s) => s.language)
  const setLanguage = useAppStore((s) => s.setLanguage)
  const code = useAppStore((s) => s.code)
  const setCode = useAppStore((s) => s.setCode)
  const diffVisible = useAppStore((s) => s.diffVisible)
  const running = useAppStore((s) => s.running)
  const runOrSubmit = useAppStore((s) => s.runOrSubmit)
  const inlineOn = useAppStore((s) => s.settings.inlineCompletions)
  const inlineScope = useAppStore((s) => s.settings.inlineScope)
  const ghostOpacity = useAppStore((s) => s.settings.ghostOpacity)
  const ghostColor = useAppStore((s) => s.settings.ghostColor)
  const ghostItalic = useAppStore((s) => s.settings.ghostItalic)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const setEditorState = useAppStore((s) => s.setEditorState)

  // The editor instance lives in React state so the effect below re-runs after React StrictMode's
  // mount → cleanup → mount cycle in development. Registering inside onMount and disposing in an effect
  // cleanup looked fine but left the app with NO cursor listener and NO ghost-text provider in `npm run dev`
  // (turns.jsonl showed every turn at L1:C1 with no selection).
  const [instance, setInstance] = useState<{ editor: MonacoEditor.IStandaloneCodeEditor; monaco: Monaco } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onMount: OnMount = (editor, monaco) => setInstance({ editor, monaco })

  useEffect(() => {
    if (!instance) return
    const { editor, monaco } = instance
    attachEditor(editor)
    const pushState = (): void => {
      const snap = readEditorState()
      if (snap) setEditorState(snap)
    }
    const cursorSub = editor.onDidChangeCursorSelection(() => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(pushState, 120)
    })
    pushState()
    const inline = registerInlineCompletions(monaco, editor)
    // Alt+\ asks for a suggestion right now (the only way to get one in "manual" trigger mode).
    const manual = editor.addAction({
      id: 'prep.ghost.trigger',
      label: 'Ghost text: suggest now',
      keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.Backslash],
      run: (ed) => {
        ed.trigger('prep', 'editor.action.inlineSuggest.trigger', null)
      }
    })
    return () => {
      cursorSub.dispose()
      manual.dispose()
      inline.forEach((d) => d.dispose())
      attachEditor(null)
    }
  }, [instance, setEditorState])

  // Colour / opacity / italic follow the settings live.
  useEffect(() => {
    if (instance) applyGhostStyle(instance.monaco, { ghostOpacity, ghostColor, ghostItalic })
  }, [instance, ghostOpacity, ghostColor, ghostItalic])

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-[#0a0c11]">
      <div className="flex h-10 flex-none items-center gap-1 border-b border-white/[0.06] px-2">
        <div className="flex items-center gap-2 rounded-t-md border-t-2 border-teal-400 bg-[#0d0f15] px-3 py-2 text-[12.5px] text-zinc-200">
          solution.{FILE_EXT[language] ?? 'txt'}
          <X size={11} className="opacity-40" />
        </div>
        <div className="px-3 py-2 text-[12.5px] text-zinc-600">notes.md</div>
        <div className="flex-1" />
        <button
          data-testid="ghost-toggle"
          onClick={() => updateSettings({ inlineCompletions: !inlineOn })}
          title={inlineOn ? 'Ghost text on — Tab accepts a suggestion. Click to turn off.' : 'Ghost text off. Click to turn on.'}
          className={`mr-1.5 inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11.5px] transition-colors ${
            inlineOn ? 'border-teal-400/40 bg-teal-400/10 text-teal-300' : 'border-white/[0.08] text-zinc-500 hover:bg-white/5'
          }`}
        >
          <Sparkles size={12} /> Ghost text {inlineOn ? 'on' : 'off'}
        </button>
        <select
          data-testid="ghost-scope"
          value={inlineScope}
          disabled={!inlineOn}
          onChange={(e) => updateSettings({ inlineScope: e.target.value as InlineScope })}
          title={INLINE_SCOPES.find((x) => x.id === inlineScope)?.hint}
          className="mr-1.5 rounded-md border border-white/[0.08] bg-[#12151c] px-2 py-1 text-[11.5px] text-zinc-400 outline-none disabled:opacity-40"
        >
          {INLINE_SCOPES.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </select>
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          className="mr-1.5 rounded-md border border-white/[0.08] bg-[#12151c] px-2 py-1 text-[11.5px] text-zinc-400 outline-none"
        >
          {LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
        <Button size="sm" variant="outline" disabled={running} onClick={() => runOrSubmit('submit')}>
          Submit
        </Button>
        <Button size="sm" className="ml-1.5" disabled={running} onClick={() => runOrSubmit('run')}>
          <Play size={11} fill="currentColor" /> Run
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1">
          <Editor
            height="100%"
            theme={EDITOR_THEME}
            beforeMount={(monaco) => applyGhostStyle(monaco, useAppStore.getState().settings)}
            language={MONACO_LANGUAGE[language] ?? 'plaintext'}
            value={code}
            onChange={(value) => setCode(value ?? '')}
            onMount={onMount}
            options={{
              fontSize: 13,
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              minimap: { enabled: false },
              tabSize: 4,
              padding: { top: 16 },
              smoothScrolling: true,
              automaticLayout: true,
              scrollBeyondLastLine: false,
              selectionHighlight: true,
              renderLineHighlight: 'all',
              inlineSuggest: { enabled: true, showToolbar: 'onHover' },
              suggest: { preview: true }
            }}
          />
        </div>
        {diffVisible && (
          <div className="max-h-[45%] flex-none overflow-y-auto border-t border-white/[0.06] py-3">
            <DiffPanel />
          </div>
        )}
      </div>

      <TerminalDrawer />
    </div>
  )
}
