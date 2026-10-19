import type { Monaco } from '@monaco-editor/react'
import type { Settings } from '@shared/types'
import { GHOST_COLORS } from '@shared/inline'

/**
 * Ghost-text look. Colour + opacity go through a Monaco theme (editorGhostText.foreground carries an alpha channel);
 * italic is a tiny injected stylesheet because Monaco has no theme key for it. Re-applied whenever the settings change.
 */
export const EDITOR_THEME = 'prep-dark'
const STYLE_ID = 'prep-ghost-style'

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

export function applyGhostStyle(monaco: Monaco, s: Pick<Settings, 'ghostOpacity' | 'ghostColor' | 'ghostItalic'>): void {
  const hex = (GHOST_COLORS[s.ghostColor] ?? GHOST_COLORS.default).hex
  const alpha = Math.round(clamp(s.ghostOpacity, 0.15, 1) * 255)
    .toString(16)
    .padStart(2, '0')
  monaco.editor.defineTheme(EDITOR_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: { 'editorGhostText.foreground': `${hex}${alpha}` }
  })
  monaco.editor.setTheme(EDITOR_THEME)

  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  el.textContent = `.monaco-editor .ghost-text-decoration, .monaco-editor .ghost-text-decoration-preview, .monaco-editor .ghost-text { font-style: ${
    s.ghostItalic ? 'italic' : 'normal'
  } !important; }`
}
