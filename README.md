# Prep — interview-prep IDE

Electron + TypeScript + React + Monaco desktop app: a LeetCode-style practice workspace with an
AI copilot panel (Ask + Agent modes) on the right, a real Monaco editor with Copilot-style ghost text
in the center, the current question on the left, and navigation (Workspace / Playgrounds / Question
library / Settings) on a far-left icon rail. You can **talk to it**: a local Python sidecar does
speech-to-text (Parakeet) and text-to-speech (Edge TTS "Ava" or Kokoro), and replies stream back
sentence by sentence while the model is still writing.

## Setup

```bash
npm install
cp .env.example .env          # fill in your API keys
py -3 -m pip install -r voice/requirements.txt   # once, for the voice sidecar (or point VOICE_PYTHON at a venv)
npm run dev
```

`.env` is read only by the **main process** — API keys never reach the renderer/browser context.

> Live keys were pasted into the chat that generated this scaffold. Treat those as burned —
> rotate/revoke them in each provider's dashboard once you're done testing.

## Scripts

| Script              | What it does |
| ------------------- | ------------ |
| `npm run dev`       | Electron + Vite dev server, DevTools open |
| `npm run debug`     | Same, plus `--inspect=5858` on the main process (attach VS Code / `chrome://inspect`) |
| `npm run build`     | Production build via `electron-vite build` |
| `npm run typecheck` | `tsc --noEmit` across main/preload and renderer |
| `npm run lint`      | ESLint over `src/` |
| `npm run smoke`     | Drives the **built** app under Playwright end-to-end (layout, real Python run, streamed AI chat, inline completion, new-playground picks a new question, library Open, voice sidecar start, Optimize diff → Accept). Run `npm run build` first. ~3 small provider calls. |
| `py -3 voice/test_client.py --port 8765` | Voice sidecar test with no mic: Edge TTS, optional Kokoro, and a wav → Parakeet round trip (uses a recording from `../voiceAgent/audio` if present, else Windows SAPI). Start the sidecar first: `py -3 -u voice/server.py --port 8765`. |

**Debugging:** in-app **Debug** menu; Settings → Debug → "Open DevTools" / "Show path". Main-process
logs (including everything the Python sidecar prints) go to `<userData>/logs/main.log`.

## Architecture

```
src/
  shared/types.ts          Types + IPC channel names shared by main/preload/renderer
  main/                    Electron main process (Node)
    env.ts                 FIRST import: loads .env before anything else (ES imports are hoisted)
    index.ts               Window, CSP (only ws://127.0.0.1 allowed), mic permission, debug menu
    ipc/ai.ts              chat (one-shot + streamed via IPC events, cancellable), chips, inline completions
    ipc/voice.ts           start/stop/status of the Python sidecar
    services/aiProviders/  Anthropic / Groq / Gemini behind one AiProvider {complete, stream} (SSE)
    services/voiceSidecar.ts  spawns voice/server.py, reads VOICE_PORT= from stdout, broadcasts state
    services/pythonRunner.ts  real local Python execution (temp file, 10s timeout)
    services/store.ts      JSON persistence for settings + playgrounds under app.getPath('userData')
    services/prompts.ts    system prompts: chips, chat (text / spoken / guided), ghost text
  preload/index.ts         contextBridge — the ONLY surface the renderer can call
  renderer/src/
    state/store.ts         one Zustand store: question/editor, chips+diff, streamed chat, voice, playgrounds
    lib/voiceClient.ts     mic capture (Chromium AEC) → 16 kHz PCM → ws; TTS audio → Web Audio playback; barge-in
    lib/sentenceChunker.ts streamed tokens → sentences (TTS starts on sentence 1)
    components/            rail/, workspace/ (question, Monaco + ghost text + diff + console, copilot), views/
    data/questions.ts      14-question seeded bank with Python starters
voice/
  server.py                Python sidecar: Silero VAD + endpointing + Parakeet (onnx-asr) + Edge TTS / Kokoro over WebSocket
  test_client.py           mic-less end-to-end test of the sidecar
```

### How a spoken turn flows

```
mic ─► renderer (AEC, 16 kHz int16) ─ws─► server.py: Silero VAD ─ endpoint ─ Parakeet ─► {"final": text}
   ─► store.sendMessage(text, {speak}) ─ipc─► main: provider.stream() ─events─► renderer appends deltas
   ─► SentenceChunker ─ws─► server.py Edge TTS (Ava) ─► mp3 ─► renderer decodes + schedules playback
   user talks over it ─► server {"bargein"} ─► renderer stops audio + cancels the LLM stream
```

The LLM "brain" deliberately stays in Electron: it sees the question and the live editor buffer and
holds the keys. The sidecar is ears and mouth only, so it stays dumb, fast, and swappable.

### What the copilot knows and can do

- Every chat/voice turn ships the file **with line numbers, a ▶ on the caret line, the caret position and the
  current selection** (`src/main/services/prompts.ts` → `renderEditor`). "What line am I on?" has a real answer.
- **Editor commands.** When you ask it to type/insert/add something, the model wraps the code in
  `<<<INSERT>>> … <<<END>>>` (typed at your caret, undoable with Ctrl+Z) or `<<<REPLACE>>> … <<<END>>>`
  (goes through the Accept/Reject diff). The renderer strips the block from what's shown and spoken, so Ava never
  reads code aloud (`splitEditorCommands` in `state/store.ts`, `lib/editorBridge.ts`).
- **Ghost text is conversation-aware:** inline completions include the last six chat/voice turns, so the
  suggestion follows what you just agreed on with the coach.
- **Modes are one click away:** Guided / Ghost text / voice engine pills in the copilot header, a ghost-text
  toggle on the editor tab bar, and the header shows `Ln, Col` so you can see what the copilot sees.

## What's real vs. mocked

- **Monaco**: real, bundled locally, real workers. **Ghost text**: Monaco inline-completions provider,
  350 ms debounce, Tab accepts. Requests go to Groq when it has a key (fastest), else the active provider.
- **Chat**: streamed over SSE from Anthropic (`claude-sonnet-5`), Groq (`openai/gpt-oss-120b`, sent
  with `reasoning_effort: low` or it returns ""), or Gemini (`gemini-flash-latest`). Cancel/barge-in aborts
  the HTTP request.
- **Python Run/Submit**: real local execution. Other languages: labeled mock.
- **Voice**: real. Parakeet on CUDA (encoder) + CPU (decoder) via the voiceAgent venv, Smart Turn v3.2 end-of-turn,`n  Edge TTS "Ava" warm at ~130–290 ms per sentence, Kokoro available locally. Numbers and env notes below.
- **Questions**: 14 seeded (Arrays & Hashing, Stack, Sliding Window, Binary Search, Intervals, DP).
  "New playground" picks a problem you haven't started; Library → Open switches the workspace,
  Practice starts a saved attempt. "Upload from file" / "Generate with AI" are not wired up yet.
- **Language server** (pyright over LSP): not yet.

## What costs API credits

| Action | Provider | Rough size |
| --- | --- | --- |
| A chat or voice turn | active provider (Anthropic by default) | 1.5–3k tokens in (the prompt includes the whole file), a few hundred out |
| An Agent chip | active provider | same; diff chips up to 2k out |
| Ghost text (each pause ≥350 ms while typing) | **Groq** when a Groq key exists, else the active provider | ~800 in / ≤160 out |
| `npm run smoke` | Anthropic ×3 + Groq ×1 | one run ≈ 10k tokens — don't loop it |
| Voice STT/TTS | none (local Parakeet; Edge TTS is free) | — |

If a turn fails with `credit balance is too low`, that's the Anthropic prepaid balance, not a rate limit;
the app logs the exact provider error in `main.log` and shows it in the chat bubble.

## Voice environment notes

- **Use the voiceAgent venv.** `.env` sets `VOICE_PYTHON=D:\Downloads\voiceAgent\.venv\Scripts\python.exe`:
  that env has onnxruntime-gpu (Parakeet on CUDA, decoder on CPU — the "hybrid" trick from
  `voiceAgent/bench/common.py`), torch cu124, Kokoro, and (added) `edge-tts`. The system `py -3` falls back to
  CPU and its Kokoro import is broken (numpy ABI), so don't clear that variable.
- **Latency measured (2026-09-10, this machine):** Parakeet 86–288 ms per turn, Edge TTS 130–290 ms per
  sentence once warm (the sidecar warms it at startup; the very first call is ~2–7 s), Smart Turn ~10 ms.
- **End of turn** is Smart Turn v3.2 (`voice/models/`, copied from voiceAgent) with the filler-word guard;
  `--max-silence 1200` is the hard fallback. A long ramble becomes several turns — that's intended.
- **Echo/barge-in:** the mic uses Chromium's echo cancellation; while Ava talks, the sidecar needs ~250 ms of
  sustained speech before it interrupts her. Headphones still help.
- **Lifecycle:** the sidecar exits on its own when Electron dies (it watches its stdin pipe), so a crashed IDE
  can't leave a Python process holding the GPU. If you ever suspect one: `netstat -ano -p tcp | findstr 127.0.0.1`
  and kill the python PID listening there.
- **speechSynthesis:** Electron exposes 0 OS voices on this machine, so the "Windows voices" engine is inert
  here; Edge TTS via the sidecar is the working path.
- HF cache: the sidecar reads `HF_HOME` from the Windows user registry and falls back to `D:\hf-cache\huggingface`.

## Next steps

1. Echo *detection* gate (voiceAgent/agent/echo_gate.py) fed with what the renderer actually played, for open-speaker use.
2. Kokoro as default when you want fully offline speech (it works in the venv; Edge is faster to first byte).
3. Real LSP (pyright) for semantic autocomplete beyond Monaco's heuristics and the AI ghost text.
4. Sandboxing for Run/Submit beyond a temp dir + timeout.
