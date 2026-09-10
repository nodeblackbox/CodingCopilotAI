import { diffLines } from 'diff'

export interface DiffLine {
  type: 'add' | 'del' | 'ctx'
  text: string
}

/** Turns two full-file strings into a flat list of +/-/context lines for the diff panel. */
/**
 * Compact "+line / -line" text (with new-file line numbers) describing what changed between two
 * snapshots — what the copilot is told about the user's edits since its last reply. Empty when nothing changed.
 */
export function describeChanges(oldCode: string, newCode: string, maxLines = 40): string {
  if (oldCode === newCode) return ''
  const out: string[] = []
  let newLine = 1
  for (const part of diffLines(oldCode, newCode)) {
    const lines = part.value.replace(/\n$/, '').split('\n')
    if (part.added) {
      for (const l of lines) {
        out.push(`+ ${String(newLine).padStart(3)}| ${l}`)
        newLine++
      }
    } else if (part.removed) {
      for (const l of lines) out.push(`-    | ${l}`)
    } else {
      newLine += lines.length
    }
  }
  return out.length > maxLines ? [...out.slice(0, maxLines), `… ${out.length - maxLines} more changed lines`].join('\n') : out.join('\n')
}

export function computeDiffLines(oldCode: string, newCode: string): DiffLine[] {
  const parts = diffLines(oldCode, newCode)
  const lines: DiffLine[] = []

  for (const part of parts) {
    const type: DiffLine['type'] = part.added ? 'add' : part.removed ? 'del' : 'ctx'
    const partLines = part.value.replace(/\n$/, '').split('\n')
    for (const text of partLines) {
      lines.push({ type, text })
    }
  }

  return lines
}
