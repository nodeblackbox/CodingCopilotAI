/**
 * Renderer side of the voice pipeline. Owns the microphone, the WebSocket to the Python sidecar, and
 * speaker playback. Emits plain events; the store decides what to do with them.
 *
 *   mic → AudioContext → downsample to 16 kHz int16 → ws (binary)
 *   ws {"type":"final"} → onFinal(text)                      (store sends it to the LLM)
 *   speak(text):
 *     webspeech → window.speechSynthesis (OS voices, instant, no round trip)
 *     edge/kokoro → ws {"type":"tts"} → {"type":"tts_audio"} → decode → scheduled AudioBufferSource
 *
 * Chromium's echoCancellation removes most of our own playback from the mic; the sidecar additionally
 * requires sustained speech before it calls a barge-in while agent_speaking is on.
 */
import type { TtsEngine } from '@shared/types'
import { slog } from './sessionLog'

export interface VoiceEvents {
  onReady: (info: { stt: string; detail: string; turn: string }) => void
  onPartial: (text: string) => void
  onFinal: (text: string) => void
  onVad: (speaking: boolean) => void
  /** The sidecar thinks the user started talking over the agent (volume is ducked until it decides). */
  onDuck: (on: boolean) => void
  onBargeIn: () => void
  onLevel: (rms: number) => void
  onPlaybackChange: (playing: boolean) => void
  onError: (message: string) => void
  onClose: () => void
}

interface PendingAudio {
  id: string
  format: 'mp3' | 'pcm16_24k'
  bytes: ArrayBuffer
}

/** Voices the OS exposes through speechSynthesis (Windows: SAPI + installed natural voices). */
export function listWebSpeechVoices(): SpeechSynthesisVoice[] {
  try {
    return window.speechSynthesis?.getVoices() ?? []
  } catch {
    return []
  }
}

/** Partial, case-insensitive name match ("Ava" → "Microsoft Ava …"), then any English voice. */
export function pickWebSpeechVoice(name: string): SpeechSynthesisVoice | null {
  const voices = listWebSpeechVoices()
  const needle = name.toLowerCase()
  return (
    voices.find((v) => v.name.toLowerCase().includes(needle)) ??
    voices.find((v) => v.lang.toLowerCase().startsWith('en-us')) ??
    voices.find((v) => v.lang.toLowerCase().startsWith('en')) ??
    voices[0] ??
    null
  )
}

export class VoiceClient {
  private ws: WebSocket | null = null
  private micStream: MediaStream | null = null
  private micCtx: AudioContext | null = null
  private micNode: ScriptProcessorNode | null = null
  private playCtx: AudioContext | null = null
  private gain: GainNode | null = null
  private volume = 0.9
  private ducked = false
  private micMuted = false
  private outputMuted = false
  private static readonly DUCK_FACTOR = 0.25
  private playQueue: PendingAudio[] = []
  private decoding = false
  private nextStart = 0
  private activeSources = new Set<AudioBufferSourceNode>()
  private ttsSeq = 0
  private awaitingIds = new Set<string>()
  private utterances = new Set<SpeechSynthesisUtterance>()
  private playing = false
  private lastLevelSent = 0
  private framesSent = 0
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private lastFramesAtBeat = 0
  private ttsRequestedAt = new Map<string, number>()
  private lastDropLog = new Map<string, number>()
  /** Sentence text per TTS id, and what was actually played (for "where did they cut me off"). */
  private ttsText = new Map<string, string>()
  private played: Array<{ text: string; start: number; dur: number } | { text: string; web: true; chars: number }> = []

  constructor(private readonly events: VoiceEvents) {}

  // ---------------------------------------------------------------- connection
  connect(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const startedAt = performance.now()
      slog('voice', 'ws_connect', { port })
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      ws.binaryType = 'arraybuffer'
      ws.onopen = () => {
        slog('voice', 'ws_open', { ms: Math.round(performance.now() - startedAt) })
        resolve()
      }
      ws.onerror = () => {
        slog('voice', 'ws_error', { port, readyState: ws.readyState }, 'error')
        reject(new Error('Could not connect to the voice server'))
      }
      ws.onclose = (e) => {
        // 1000 after we asked to close is normal; anything else is the voice dying under us.
        slog('voice', 'ws_close', { code: e.code, reason: e.reason, clean: e.wasClean, framesSent: this.framesSent }, e.code === 1000 ? 'info' : 'warn')
        this.stopHeartbeat()
        this.ws = null
        this.events.onClose()
      }
      ws.onmessage = (e) => this.handleMessage(e.data)
      this.ws = ws
    })
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  private send(msg: Record<string, unknown>): void {
    if (this.connected) {
      this.ws!.send(JSON.stringify(msg))
      return
    }
    // Used to vanish silently. Log it, at most once per message type every 5 s.
    const type = String(msg.type)
    const now = Date.now()
    if (now - (this.lastDropLog.get(type) ?? 0) > 5000) {
      this.lastDropLog.set(type, now)
      slog('voice', 'send_dropped', { type, readyState: this.ws?.readyState ?? 'no-socket' }, 'warn')
    }
  }

  private handleMessage(data: string | ArrayBuffer): void {
    if (typeof data !== 'string') {
      slog('voice', 'unexpected_binary_frame', { bytes: data.byteLength }, 'warn')
      return
    }
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(data)
    } catch {
      slog('voice', 'bad_server_frame', { head: data.slice(0, 80) }, 'warn')
      return
    }
    switch (msg.type) {
      case 'ready':
        slog('stt', 'ready', { stt: msg.stt, detail: msg.detail, turn: msg.turn })
        this.events.onReady({ stt: String(msg.stt), detail: String(msg.detail ?? ''), turn: String(msg.turn ?? '') })
        break
      case 'partial':
        this.events.onPartial(String(msg.text))
        break
      case 'final':
        slog('stt', 'final', { text: msg.text, asrMs: msg.asr_ms, turn: msg.turn, turnP: msg.turn_p })
        this.events.onFinal(String(msg.text))
        break
      case 'vad':
        slog('voice', 'vad', { speaking: msg.speaking })
        this.events.onVad(Boolean(msg.speaking))
        break
      case 'duck':
        slog('voice', 'duck', { on: msg.on })
        this.setDucked(Boolean(msg.on))
        this.events.onDuck(Boolean(msg.on))
        break
      case 'bargein':
        slog('voice', 'bargein', { playing: this.playing })
        this.setDucked(false)
        this.events.onBargeIn()
        break
      case 'tts_audio': {
        const id = String(msg.id)
        if (!this.awaitingIds.has(id)) {
          slog('tts', 'audio_discarded', { id, why: 'cancelled' })
          return // cancelled before it came back
        }
        const requested = this.ttsRequestedAt.get(id)
        slog('tts', 'audio', {
          id,
          format: msg.format,
          b64Chars: String(msg.data).length,
          latencyMs: requested ? Math.round(performance.now() - requested) : undefined
        })
        const raw = atob(String(msg.data))
        const bytes = new Uint8Array(raw.length)
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
        this.playQueue.push({ id, format: msg.format as PendingAudio['format'], bytes: bytes.buffer })
        void this.drainQueue()
        break
      }
      case 'tts_end':
        this.ttsRequestedAt.delete(String(msg.id))
        this.awaitingIds.delete(String(msg.id))
        this.maybePlaybackDone()
        break
      case 'error':
        slog('voice', 'server_error', { message: msg.message }, 'error')
        this.events.onError(String(msg.message))
        break
      default:
        slog('voice', 'unknown_message', { type: msg.type }, 'warn')
    }
  }

  // ---------------------------------------------------------------- microphone
  async startMic(): Promise<void> {
    if (this.micStream) return
    const t0 = performance.now()
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      })
    } catch (err) {
      slog('voice', 'mic_denied', { name: (err as Error).name, message: (err as Error).message }, 'error')
      throw err
    }
    const track = this.micStream.getAudioTracks()[0]
    slog('voice', 'mic_start', { label: track?.label, ms: Math.round(performance.now() - t0), settings: track?.getSettings?.() })
    // Unplugged / revoked / taken by another app: the stream ends and audio silently stops flowing.
    track?.addEventListener('ended', () => slog('voice', 'mic_track_ended', { label: track.label }, 'error'))
    track?.addEventListener('mute', () => slog('voice', 'mic_track_muted', { label: track.label }, 'warn'))
    track?.addEventListener('unmute', () => slog('voice', 'mic_track_unmuted', { label: track.label }))
    this.micCtx = new AudioContext()
    this.micCtx.addEventListener('statechange', () => slog('voice', 'mic_ctx_state', { state: this.micCtx?.state }))
    this.startHeartbeat()
    const source = this.micCtx.createMediaStreamSource(this.micStream)
    // ScriptProcessorNode is deprecated but needs no separate worklet file; 4096 frames ≈ 85 ms at 48 kHz.
    const node = this.micCtx.createScriptProcessor(4096, 1, 1)
    const inRate = this.micCtx.sampleRate
    node.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0)
      const now = performance.now()
      if (now - this.lastLevelSent > 80) {
        this.lastLevelSent = now
        let sum = 0
        for (let i = 0; i < input.length; i += 4) sum += input[i] * input[i]
        this.events.onLevel(Math.sqrt(sum / (input.length / 4)))
      }
      if (this.connected) {
        this.ws!.send(downsampleToInt16(input, inRate, 16000))
        this.framesSent++
      }
    }
    source.connect(node)
    node.connect(this.micCtx.destination) // required for onaudioprocess to fire; the node outputs silence
    this.micNode = node
    this.send({ type: 'mic', on: !this.micMuted })
  }

  /** Mute: keep capturing (so the level meter still moves) but tell the sidecar to drop frames. */
  setMicMuted(muted: boolean): void {
    this.micMuted = muted
    slog('voice', 'mic_muted', { muted })
    if (this.micStream) this.send({ type: 'mic', on: !muted })
  }

  /** Every 15 s while the mic is open: frames actually sent, socket buffer, AudioContext state. 0 frames = dead audio path. */
  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.lastFramesAtBeat = this.framesSent
    this.heartbeat = setInterval(() => {
      const sent = this.framesSent - this.lastFramesAtBeat
      this.lastFramesAtBeat = this.framesSent
      const stalled = sent === 0 && !this.micMuted
      slog(
        'voice',
        'mic_heartbeat',
        { frames: sent, buffered: this.ws?.bufferedAmount, ctx: this.micCtx?.state, muted: this.micMuted, wsOpen: this.connected },
        stalled ? 'warn' : 'info'
      )
    }, 15_000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  stopMic(): void {
    slog('voice', 'mic_stop', { framesSent: this.framesSent })
    this.stopHeartbeat()
    this.send({ type: 'mic', on: false })
    this.micNode?.disconnect()
    this.micNode = null
    this.micStream?.getTracks().forEach((t) => t.stop())
    this.micStream = null
    void this.micCtx?.close()
    this.micCtx = null
  }

  get micActive(): boolean {
    return this.micStream !== null
  }

  // ---------------------------------------------------------------- speaker
  /** 0–1. Applies immediately to what's playing (Web Audio gain) and to future speechSynthesis utterances. */
  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume))
    this.applyGain()
  }

  private setDucked(on: boolean): void {
    this.ducked = on
    this.applyGain()
  }

  /** Deafen: silence whatever's playing/queued next, independent of the volume slider. */
  setOutputMuted(muted: boolean): void {
    this.outputMuted = muted
    slog('voice', 'deafen', { muted })
    this.applyGain()
  }

  private applyGain(): void {
    if (!this.gain || !this.playCtx) return
    const target = this.outputMuted ? 0 : this.volume * (this.ducked ? VoiceClient.DUCK_FACTOR : 1)
    this.gain.gain.setTargetAtTime(target, this.playCtx.currentTime, 0.02)
  }

  speak(text: string, engine: TtsEngine, voice: string): void {
    this.setPlaying(true)
    slog('tts', 'request', { engine, chars: text.length, voice })
    if (engine === 'webspeech') {
      this.speakWeb(text, voice)
      return
    }
    const id = `t${++this.ttsSeq}`
    this.awaitingIds.add(id)
    this.ttsRequestedAt.set(id, performance.now())
    this.ttsText.set(id, text)
    this.send({ type: 'tts', id, text, engine, voice })
  }

  /**
   * What the listener has actually heard of the current speech so far: finished sentences in full, the one
   * playing now cut at the proportional word. Null when nothing of this reply has started playing.
   */
  heardSoFar(): string | null {
    if (!this.played.length) return null
    const now = this.playCtx?.currentTime ?? 0
    const parts: string[] = []
    for (const p of this.played) {
      if ('web' in p) {
        parts.push(p.chars >= p.text.length ? p.text : p.text.slice(0, p.chars))
        continue
      }
      if (now >= p.start + p.dur) parts.push(p.text)
      else if (now > p.start) {
        const w = p.text.split(/\s+/)
        parts.push(w.slice(0, Math.max(1, Math.floor((w.length * (now - p.start)) / p.dur))).join(' ') + '…')
        break
      } else break
    }
    return parts.join(' ').trim()
  }

  private speakWeb(text: string, voiceName: string): void {
    const synth = window.speechSynthesis
    if (!synth) {
      slog('tts', 'webspeech_unavailable', undefined, 'error')
      this.events.onError('speechSynthesis is not available in this window')
      this.maybePlaybackDone()
      return
    }
    const u = new SpeechSynthesisUtterance(text)
    const v = pickWebSpeechVoice(voiceName)
    if (v) u.voice = v
    u.rate = 1.05
    u.volume = this.outputMuted ? 0 : this.volume
    const heard = { text, web: true as const, chars: 0 }
    u.onstart = () => this.played.push(heard)
    u.onboundary = (e) => {
      heard.chars = e.charIndex + (e.charLength || 0)
    }
    this.utterances.add(u)
    const done = (): void => {
      heard.chars = text.length
      this.utterances.delete(u)
      this.maybePlaybackDone()
    }
    u.onend = done
    u.onerror = (e) => {
      if (e.error !== 'interrupted' && e.error !== 'canceled') {
        slog('tts', 'webspeech_error', { error: e.error }, 'error')
        this.events.onError(`speechSynthesis: ${e.error}`)
      }
      done()
    }
    synth.speak(u)
  }

  /** Barge-in / new turn: drop everything queued and stop what's playing now. */
  stopSpeaking(): void {
    if (this.playing || this.awaitingIds.size || this.playQueue.length) {
      slog('tts', 'cancel', { pending: this.awaitingIds.size, queued: this.playQueue.length, sources: this.activeSources.size })
    }
    this.ttsRequestedAt.clear()
    this.ttsText.clear()
    this.played = []
    this.send({ type: 'tts_cancel' })
    this.awaitingIds.clear()
    this.playQueue = []
    for (const src of this.activeSources) {
      try {
        src.stop()
      } catch {
        /* already stopped */
      }
    }
    this.activeSources.clear()
    this.nextStart = 0
    this.setDucked(false)
    if (this.utterances.size) {
      this.utterances.clear()
      try {
        window.speechSynthesis?.cancel()
      } catch {
        /* ignore */
      }
    }
    this.setPlaying(false)
  }

  private setPlaying(playing: boolean): void {
    if (this.playing === playing) return
    this.playing = playing
    slog('voice', 'playback', { playing })
    this.send({ type: 'agent_speaking', on: playing })
    this.events.onPlaybackChange(playing)
  }

  private maybePlaybackDone(): void {
    if (
      this.awaitingIds.size === 0 &&
      this.playQueue.length === 0 &&
      this.activeSources.size === 0 &&
      this.utterances.size === 0 &&
      !this.decoding
    ) {
      this.setPlaying(false)
    }
  }

  private async drainQueue(): Promise<void> {
    if (this.decoding) return
    this.decoding = true
    try {
      while (this.playQueue.length) {
        const item = this.playQueue.shift()!
        const buffer = await this.decode(item)
        if (!buffer) continue
        this.schedule(buffer, item.id)
      }
    } finally {
      this.decoding = false
      this.maybePlaybackDone()
    }
  }

  private async decode(item: PendingAudio): Promise<AudioBuffer | null> {
    const ctx = this.ensurePlayCtx()
    try {
      if (item.format === 'mp3') return await ctx.decodeAudioData(item.bytes.slice(0))
      const int16 = new Int16Array(item.bytes)
      const buffer = ctx.createBuffer(1, int16.length, 24000)
      const ch = buffer.getChannelData(0)
      for (let i = 0; i < int16.length; i++) ch[i] = int16[i] / 32768
      return buffer
    } catch (err) {
      slog('tts', 'decode_failed', { id: item.id, format: item.format, message: (err as Error).message }, 'error')
      this.events.onError(`Audio decode failed: ${(err as Error).message}`)
      return null
    }
  }

  private schedule(buffer: AudioBuffer, id: string): void {
    const ctx = this.ensurePlayCtx()
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(this.gain!)
    const start = Math.max(ctx.currentTime + 0.02, this.nextStart)
    src.start(start)
    this.nextStart = start + buffer.duration
    this.played.push({ text: this.ttsText.get(id) ?? '', start, dur: buffer.duration })
    this.ttsText.delete(id)
    this.activeSources.add(src)
    src.onended = () => {
      this.activeSources.delete(src)
      this.maybePlaybackDone()
    }
  }

  private ensurePlayCtx(): AudioContext {
    if (!this.playCtx) {
      this.playCtx = new AudioContext()
      this.gain = this.playCtx.createGain()
      this.gain.connect(this.playCtx.destination)
      this.applyGain()
    }
    if (this.playCtx.state === 'suspended') void this.playCtx.resume()
    return this.playCtx
  }

  // ---------------------------------------------------------------- teardown
  close(): void {
    slog('voice', 'client_close')
    this.stopSpeaking()
    this.stopMic()
    this.ws?.close()
    this.ws = null
    void this.playCtx?.close()
    this.playCtx = null
    this.gain = null
  }
}

/** Linear-interpolation downsample of float32 audio to int16 at outRate. */
function downsampleToInt16(input: Float32Array, inRate: number, outRate: number): ArrayBuffer {
  const ratio = inRate / outRate
  const outLen = Math.floor(input.length / ratio)
  const out = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = pos - i0
    const sample = input[i0] * (1 - frac) + input[i1] * frac
    out[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)))
  }
  return out.buffer
}
