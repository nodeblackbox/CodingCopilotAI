/**
 * The one place that holds a reference to the live Monaco editor, so non-React code (the store, voice
 * commands) can type into it. Edits go through executeEdits, so Ctrl+Z undoes them like any keystroke.
 */
import type { editor as MonacoEditor } from 'monaco-editor'

type Editor = MonacoEditor.IStandaloneCodeEditor

let current: Editor | null = null

export function attachEditor(editor: Editor | null): void {
  current = editor
}

export function hasEditor(): boolean {
  return current !== null
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
