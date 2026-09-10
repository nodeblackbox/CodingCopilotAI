/**
 * Minimal Server-Sent-Events reader over fetch's body stream.
 * Calls onData with each `data:` payload (multi-line data joined with \n). Ignores comments/other fields.
 */
export async function readSse(res: Response, onData: (data: string) => void): Promise<void> {
  if (!res.body) throw new Error('Response has no body to stream')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines: string[] = []

  const flushEvent = (): void => {
    if (dataLines.length) onData(dataLines.join('\n'))
    dataLines = []
  }

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '')
      buffer = buffer.slice(nl + 1)
      if (line === '') {
        flushEvent()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''))
      }
    }
  }
  flushEvent()
}

export async function httpError(res: Response, label: string): Promise<Error> {
  const body = await res.text().catch(() => '')
  return new Error(`${label} API error ${res.status}: ${body.slice(0, 300)}`)
}
