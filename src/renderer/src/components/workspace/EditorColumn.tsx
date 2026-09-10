import { useEffect, useRef } from 'react'
import Editor, { type Monaco, type OnMount } from '@monaco-editor/react'
import type { IDisposable } from 'monaco-editor'
import { Play, Sparkles, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/Button'
import { DiffPanel } from './DiffPanel'
import { TerminalDrawer } from './TerminalDrawer'
import { useAppStore } from '@renderer/state/store'
import { attachEditor } from '@renderer/lib/editorBridge'

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

const INLINE_DEBOUNCE_MS = 350
const CONTEXT_LINES_BEFORE = 80
const CONTEXT_LINES_AFTER = 30
const CONVERSATION_TURNS = 6

/** Bumped per keystroke; a request that finishes after a newer one started is thrown away. */
let inlineSeq = 0

/** The last few chat/voice turns, so ghost text follows what the user and the coach just agreed on. */
function recentConversation(): string {
  return useAppStore
    .getState()
    .messages.slice(-CONVERSATION_TURNS)
    .map((m) => `${m.role === 'user' ? 'user' : 'coach'}: ${m.text.replace(/\s+/g, ' ').slice(0, 300)}`)
    .join('\n')
}

/**
 * Copilot-style ghost text. Monaco calls provideInlineCompletions on every edit; we debounce, ship the
 * code around the cursor (plus the recent conversation) to main, and hand back one suggestion.
 * Tab accepts it — that's Monaco's built-in inline-suggest UX, nothing custom here.
 */
function registerInlineCompletions(monaco: Monaco): IDisposable[] {
  const provider = {
    provideInlineCompletions: async (
      model: import('monaco-editor').editor.ITextModel,
      position: import('monaco-editor').Position,
      _ctx: unknown,
      token: import('monaco-editor').CancellationToken
    ) => {
      if (!useAppStore.getState().settings.inlineCompletions) return { items: [] }
      const seq = ++inlineSeq
      await new Promise((r) => setTimeout(r, INLINE_DEBOUNCE_MS))
      if (token.isCancellationRequested || seq !== inlineSeq) return { items: [] }

      const lastLine = Math.min(model.getLineCount(), position.lineNumber + CONTEXT_LINES_AFTER)
      const prefix = model.getValueInRange({
        startLineNumber: Math.max(1, position.lineNumber - CONTEXT_LINES_BEFORE),
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

      const res = await window.api.ai.inlineComplete({
        language: model.getLanguageId(),
        prefix,
        suffix,
        questionTitle: useAppStore.getState().question.title,
        conversation: recentConversation()
      })
      if (token.isCancellationRequested || seq !== inlineSeq || !res.text) return { items: [] }
      return {
        items: [
          {
            insertText: res.text,
            range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column)
          }
        ]
      }
    },
    freeInlineCompletions: () => {}
  }
  return Object.values(MONACO_LANGUAGE).map((lang) => monaco.languages.registerInlineCompletionsProvider(lang, provider))
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
  const updateSettings = useAppStore((s) => s.updateSettings)
  const setEditorState = useAppStore((s) => s.setEditorState)
  const disposables = useRef<IDisposable[]>([])

  const onMount: OnMount = (editor, monaco) => {
    disposables.current.forEach((d) => d.dispose())
    attachEditor(editor)
    // Caret + selection go to the store (throttled) so every chat/voice turn knows where the user is.
    let timer: ReturnType<typeof setTimeout> | null = null
    const pushState = (): void => {
      const pos = editor.getPosition()
      const sel = editor.getSelection()
      const model = editor.getModel()
      if (!pos || !model) return
      setEditorState({
        cursor: { line: pos.lineNumber, column: pos.column },
        selection: sel && !sel.isEmpty() ? model.getValueInRange(sel) : ''
      })
    }
    const cursorSub = editor.onDidChangeCursorSelection(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(pushState, 120)
    })
    pushState()
    disposables.current = [...registerInlineCompletions(monaco), cursorSub, { dispose: () => attachEditor(null) }]
  }

  useEffect(() => () => disposables.current.forEach((d) => d.dispose()), [])

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
            theme="vs-dark"
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
