import { diffLines } from 'diff'

export interface DiffLine {
  type: 'add' | 'del' | 'ctx'
  text: string
}

/** Turns two full-file strings into a flat list of +/-/context lines for the diff panel. */
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
