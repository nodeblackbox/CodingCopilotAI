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

  constructor(private readonly events: VoiceEvents) {}

  // ---------------------------------------------------------------- connection
  connect(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      ws.binaryType = 'arraybuffer'
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('Could not connect to the voice server'))
      ws.onclose = () => {
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
    if (this.connected) this.ws!.send(JSON.stringify(msg))
  }

  private handleMessage(data: string | ArrayBuffer): void {
    if (typeof data !== 'string') return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    switch (msg.type) {
      case 'ready':
        this.events.onReady({ stt: String(msg.stt), detail: String(msg.detail ?? ''), turn: String(msg.turn ?? '') })
        break
      case 'partial':
        this.events.onPartial(String(msg.text))
        break
      case 'final':
        this.events.onFinal(String(msg.text))
        break
      case 'vad':
        this.events.onVad(Boolean(msg.speaking))
        break
      case 'duck':
        this.setDucked(Boolean(msg.on))
        this.events.onDuck(Boolean(msg.on))
        break
      case 'bargein':
        this.setDucked(false)
        this.events.onBargeIn()
        break
      case 'tts_audio': {
        const id = String(msg.id)
        if (!this.awaitingIds.has(id)) return // cancelled before it came back
        const raw = atob(String(msg.data))
        const bytes = new Uint8Array(raw.length)
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
        this.playQueue.push({ id, format: msg.format as PendingAudio['format'], bytes: bytes.buffer })
        void this.drainQueue()
        break
      }
      case 'tts_end':
        this.awaitingIds.delete(String(msg.id))
        this.maybePlaybackDone()
        break
      case 'error':
        this.events.onError(String(msg.message))
        break
    }
  }

  // ---------------------------------------------------------------- microphone
  async startMic(): Promise<void> {
    if (this.micStream) return
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    })
    this.micCtx = new AudioContext()
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
      if (this.connected) this.ws!.send(downsampleToInt16(input, inRate, 16000))
    }
    source.connect(node)
    node.connect(this.micCtx.destination) // required for onaudioprocess to fire; the node outputs silence
    this.micNode = node
    this.send({ type: 'mic', on: true })
  }

  stopMic(): void {
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

  private applyGain(): void {
    if (!this.gain || !this.playCtx) return
    const target = this.volume * (this.ducked ? VoiceClient.DUCK_FACTOR : 1)
    this.gain.gain.setTargetAtTime(target, this.playCtx.currentTime, 0.02)
  }

  speak(text: string, engine: TtsEngine, voice: string): void {
    this.setPlaying(true)
    if (engine === 'webspeech') {
      this.speakWeb(text, voice)
      return
    }
    const id = `t${++this.ttsSeq}`
    this.awaitingIds.add(id)
    this.send({ type: 'tts', id, text, engine, voice })
  }

  private speakWeb(text: string, voiceName: string): void {
    const synth = window.speechSynthesis
    if (!synth) {
      this.events.onError('speechSynthesis is not available in this window')
      this.maybePlaybackDone()
      return
    }
    const u = new SpeechSynthesisUtterance(text)
    const v = pickWebSpeechVoice(voiceName)
    if (v) u.voice = v
    u.rate = 1.05
    u.volume = this.volume
    this.utterances.add(u)
    const done = (): void => {
      this.utterances.delete(u)
      this.maybePlaybackDone()
    }
    u.onend = done
    u.onerror = (e) => {
      if (e.error !== 'interrupted' && e.error !== 'canceled') this.events.onError(`speechSynthesis: ${e.error}`)
      done()
    }
    synth.speak(u)
  }

  /** Barge-in / new turn: drop everything queued and stop what's playing now. */
  stopSpeaking(): void {
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
        this.schedule(buffer)
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
      this.events.onError(`Audio decode failed: ${(err as Error).message}`)
      return null
    }
  }

  private schedule(buffer: AudioBuffer): void {
    const ctx = this.ensurePlayCtx()
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(this.gain!)
    const start = Math.max(ctx.currentTime + 0.02, this.nextStart)
    src.start(start)
    this.nextStart = start + buffer.duration
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
