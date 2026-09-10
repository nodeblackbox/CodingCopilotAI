/**
 * Feed streamed LLM text fragments; get back complete sentences as they close, so TTS can start on
 * sentence one while the model is still writing sentence three. Port of the voiceAgent SentenceChunker.
 */
export class SentenceChunker {
  private buf = ''
  private emitted = 0
  private static readonly END = /([.!?…]+["')\]]*)(\s+|$)/
  private static readonly CLAUSE = /([,;:—–-])\s+/

  constructor(
    private readonly maxChars = 220,
    private readonly firstMinWords = 6
  ) {}

  feed(piece: string): string[] {
    this.buf += piece
    const out: string[] = []
    for (;;) {
      const m = SentenceChunker.END.exec(this.buf)
      if (m && m.index !== undefined && (m.index + m[0].length < this.buf.length || m[2])) {
        const end = m.index + m[0].length
        out.push(this.buf.slice(0, end).trim())
        this.buf = this.buf.slice(end)
        continue
      }
      const nl = this.buf.indexOf('\n')
      if (nl >= 0) {
        const s = this.buf.slice(0, nl).trim()
        this.buf = this.buf.slice(nl + 1)
        if (s) out.push(s)
        continue
      }
      if (this.emitted === 0 && out.length === 0 && this.firstMinWords) {
        const cm = SentenceChunker.CLAUSE.exec(this.buf)
        if (cm && cm.index !== undefined && this.buf.slice(0, cm.index).split(/\s+/).filter(Boolean).length >= this.firstMinWords) {
          const end = cm.index + cm[0].length
          out.push(this.buf.slice(0, end).trim())
          this.buf = this.buf.slice(end)
          continue
        }
      }
      if (this.buf.length > this.maxChars) {
        let cut = Math.max(this.buf.lastIndexOf(', ', this.maxChars), this.buf.lastIndexOf(' ', this.maxChars))
        if (cut <= 0) cut = this.maxChars
        out.push(this.buf.slice(0, cut).trim())
        this.buf = this.buf.slice(cut).replace(/^\s+/, '')
        continue
      }
      break
    }
    this.emitted += out.length
    return out.filter(Boolean)
  }

  flush(): string[] {
    const s = this.buf.trim()
    this.buf = ''
    if (!s) return []
    this.emitted += 1
    return [s]
  }
}
