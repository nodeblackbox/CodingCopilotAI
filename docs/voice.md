# Voice pipeline

The voice sidecar (`voice/server.py`) is a single local WebSocket server. It turns microphone audio into text and text into speech. It deliberately contains **no LLM**.

```
renderer mic (16 kHz int16 PCM) ─► Silero VAD ─► Smart Turn v3.2 endpointing ─► Parakeet ─► {"type":"final"}
renderer {"type":"tts","text"}  ─► Edge TTS (en-US-AvaNeural) / Kokoro ─► {"type":"tts_audio",...}
```

Electron spawns it, reads `VOICE_PORT=<n>` from stdout, and the renderer connects to `ws://127.0.0.1:<n>`. The sidecar exits by itself when Electron dies (it watches its stdin pipe), so a crashed IDE cannot leave Python holding the GPU.

## How a spoken turn flows

1. **Capture.** The renderer records the mic with Chromium's echo cancellation, resamples to 16 kHz and streams binary frames.
2. **Voice activity.** Silero VAD scores each 32 ms frame.
3. **End of turn.** After `--min-silence` ms, Smart Turn v3.2 (about 10 ms on CPU) scores the last 8 s every `--check-every` ms. The turn ends when it is confident, or at `--max-silence` regardless. A mid-confidence score on a trailing filler word ("um", "so", "and") is held, so you are not cut off mid-hedge.
4. **Transcribe.** Parakeet TDT 0.6B v3 (ONNX) returns the text. Measured on one machine: 86 to 288 ms per turn.
5. **Think.** The renderer sends the text to Electron main, which streams the model's reply.
6. **Speak.** A sentence chunker cuts the token stream into sentences; each goes to the sidecar for synthesis, so speech starts after the first sentence rather than the last. Edge TTS is about 130 to 290 ms per sentence once warm.

## Barge-in

You always have precedence. Interrupting is two-stage:

| Stage | Trigger | Effect |
|---|---|---|
| **Duck** | about 3 credits (~100 ms) of speech | assistant volume drops to 25 %; a short "mhm" passes and volume recovers |
| **Cut** | about 10 credits (~320 ms) | audio stops, the model request is cancelled, your words become the next turn |

"Credit" accumulates per 32 ms VAD hit with score ≥ 0.6 and only leaks one point per miss. If you start talking while the reply is still being generated (no audio yet), the reply is cancelled and your next sentence is merged with the previous one into a single turn. Tune with `--bargein-*` and `--duck-chunks`.

## Protocol

JSON text frames, plus binary frames for mic audio.

| Direction | Message | Meaning |
|---|---|---|
| client → server | binary | mic PCM (any size; re-chunked to 32 ms) |
| client → server | `{"type":"mic","on":bool}` | start or stop treating audio as speech |
| client → server | `{"type":"agent_speaking","on":bool}` | TTS is playing; raise the barge-in bar |
| client → server | `{"type":"tts","id","text","engine","voice"}` | synthesise one sentence |
| client → server | `{"type":"tts_cancel"}` | drop all pending synthesis |
| server → client | `{"type":"ready","stt","tts","turn"}` | capabilities after startup |
| server → client | `{"type":"vad","speaking"}` | user speech started or stopped |
| server → client | `{"type":"duck","on"}` | lower or restore playback volume |
| server → client | `{"type":"bargein"}` | stop the agent now |
| server → client | `{"type":"partial","text"}` | live caption |
| server → client | `{"type":"final","text","asr_ms","turn"}` | finished utterance |

## Setup and tuning

```bash
python -m venv .venv
.venv\Scripts\activate           # macOS/Linux: source .venv/bin/activate
pip install -r voice/requirements.txt
```

Set `VOICE_PYTHON` in `.env` to that venv's interpreter.

- **GPU:** `pip install onnx-asr[gpu]` plus an onnxruntime-gpu build matching your CUDA version. Parakeet's encoder runs on CUDA and the decoder on CPU (a hybrid that was faster than all-GPU in testing). Set `PARAKEET_DEVICE=cuda`, or leave `auto`.
- **Model cache:** the first run downloads about 2.4 GB from Hugging Face. Set `HF_HOME` to put the cache on a bigger drive; on Windows the sidecar also reads it from your user environment.
- **Kokoro (offline TTS):** `pip install kokoro` and pick it in Settings. Edge TTS is faster to first byte but needs internet.
- **Echo:** use headphones. The echo guard (see [spend-and-costs.md](spend-and-costs.md)) is a safety net, not a substitute.

## Testing without a microphone

```bash
python -u voice/server.py --port 8765
python voice/test_client.py --port 8765
```

The client checks Edge TTS, optionally Kokoro, and a wav → Parakeet round trip. Set `PREP_TEST_AUDIO` to a folder of 16 kHz wavs with matching transcripts; otherwise it synthesises an utterance with Windows SAPI.
