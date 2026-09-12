/**
 * The one place that holds a reference to the live Monaco editor, so non-React code (the store, voice
 * commands) can type into it, move the caret, highlight lines, and read the caret/selection synchronously.
 * Edits go through executeEdits, so Ctrl+Z undoes them like any keystroke.
 */
import type { editor as MonacoEditor } from 'monaco-editor'
import type { CursorInfo, SelectionRange } from '@shared/types'

type Editor = MonacoEditor.IStandaloneCodeEditor

let current: Editor | null = null

export function attachEditor(editor: Editor | null): void {
  current = editor
}

export function hasEditor(): boolean {
  return current !== null
}

export interface EditorSnapshot {
  cursor: CursorInfo
  selection: string
  selectionRange: SelectionRange | null
}

/** Caret + selection right now (not the throttled copy in the store). Null when no editor is mounted. */
export function readEditorState(): EditorSnapshot | null {
  if (!current) return null
  const pos = current.getPosition()
  const sel = current.getSelection()
  const model = current.getModel()
  if (!pos || !model) return null
  const hasSel = sel !== null && !sel.isEmpty()
  return {
    cursor: { line: pos.lineNumber, column: pos.column },
    selection: hasSel ? model.getValueInRange(sel) : '',
    selectionRange: hasSel ? { startLine: sel.startLineNumber, endLine: sel.endLineNumber } : null
  }
}

/** Insert at the cursor (replacing the selection if there is one). Returns the line it landed on, or null. */
export function insertAtCursor(text: string): number | null {
  if (!current) return null
  const sel = current.getSelection()
  const pos = current.getPosition()
  if (!sel || !pos) return null
  const range = sel.isEmpty()
    ? { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column }
    : sel
  // Make whole-line insertions land on their own line: models often forget the newline when the caret
  // is at the start (or end) of an existing line, which would glue the new code onto that line.
  const lineText = current.getModel()?.getLineContent(pos.lineNumber) ?? ''
  let payload = text
  if (lineText.trim() === '') {
    payload = payload.replace(/^\n+/, '')
  } else if (sel.isEmpty()) {
    const beforeCaret = lineText.slice(0, pos.column - 1)
    const afterCaret = lineText.slice(pos.column - 1)
    if (beforeCaret.trim() === '' && afterCaret.trim() !== '' && !payload.endsWith('\n')) payload += '\n'
    if (afterCaret.trim() === '' && beforeCaret.trim() !== '' && !payload.startsWith('\n')) payload = '\n' + payload
  }
  current.pushUndoStop()
  current.executeEdits('copilot', [{ range, text: payload, forceMoveMarkers: true }])
  current.pushUndoStop()
  current.focus()
  return pos.lineNumber
}

export function revealLine(line: number): void {
  current?.revealLineInCenter(line)
}

/** Move the caret to a line (clamped) and scroll it into view. Returns the line actually reached. */
export function gotoLine(line: number): number | null {
  if (!current) return null
  const model = current.getModel()
  if (!model) return null
  const n = Math.max(1, Math.min(model.getLineCount(), Math.floor(line)))
  current.setPosition({ lineNumber: n, column: 1 })
  current.revealLineInCenter(n)
  current.focus()
  return n
}

/** Highlight whole lines a..b (inclusive, clamped, either order). Returns the range actually selected. */
export function selectLines(a: number, b: number): SelectionRange | null {
  if (!current) return null
  const model = current.getModel()
  if (!model) return null
  const max = model.getLineCount()
  const start = Math.max(1, Math.min(max, Math.min(a, b)))
  const end = Math.max(1, Math.min(max, Math.max(a, b)))
  current.setSelection({
    startLineNumber: start,
    startColumn: 1,
    endLineNumber: end,
    endColumn: model.getLineMaxColumn(end)
  })
  current.revealLinesInCenter(start, end)
  current.focus()
  return { startLine: start, endLine: end }
}
