# Architecture

Prep is an Electron app with three JavaScript contexts and one optional Python process.

```
┌──────────────────────────── Electron ────────────────────────────┐
│  Renderer (React, Monaco, Zustand)      sandboxed, no API keys    │
│        │  window.api.*  (contextBridge)                           │
│  Preload  ───────────────────────────────  the ONLY surface       │
│        │  IPC                                                      │
│  Main (Node)                                                      │
│    ├─ aiProviders/  Anthropic · Groq · Gemini  (SSE streaming)    │
│    ├─ pythonRunner  real local execution, 10 s timeout            │
│    ├─ store         JSON settings + playgrounds in userData       │
│    ├─ prompts       system prompts, editor rendering              │
│    ├─ usageLedger   spend meter, daily budget                     │
│    └─ voiceSidecar  spawns voice/server.py                        │
└───────────────────────────────┬───────────────────────────────────┘
                                │ ws://127.0.0.1:<port>
                    ┌───────────┴────────────┐
                    │ Python sidecar         │  ears and mouth only
                    │ Silero · Parakeet · TTS│
                    └────────────────────────┘
```

## Why the brain lives in Electron main

The model needs the question, the live editor buffer and the API keys. Keeping it in the main process means keys never touch the renderer, the CSP can stay tight (the only network origin the renderer may open is `ws://127.0.0.1`), and the Python sidecar stays a dumb, swappable audio component.

## Folder map

```
src/
  shared/                  Types and IPC channel names shared by every context
    types.ts · inline.ts · voiceIntents.ts
  main/                    Electron main process
    env.ts                 FIRST import: loads .env before anything else (ES imports are hoisted)
    index.ts               Window, CSP, mic permission, debug menu
    ipc/                   ai · voice · run · storage · debug handlers
    services/
      aiProviders/         one AiProvider { complete, stream } interface, three implementations
      prompts.ts           chips, chat (text / spoken / guided), ghost text, renderEditor()
      pythonRunner.ts      temp file + timeout
      store.ts             settings + playgrounds
      usageLedger.ts       usage.jsonl and the budget check
      turnLog.ts           turns.jsonl: exactly what the model was shown
      sessionLog.ts        per-run structured logs
      voiceSidecar.ts      spawn, port handshake, state broadcast
  preload/index.ts         contextBridge API
  renderer/src/
    state/store.ts         one Zustand store: question/editor, chips + diff, chat, voice, playgrounds
    lib/voiceClient.ts     mic capture (Chromium AEC) → 16 kHz PCM → ws; TTS playback; barge-in
    lib/sentenceChunker.ts streamed tokens → sentences
    lib/editorBridge.ts    typing/selecting in Monaco on the model's behalf
    lib/diffLines.ts       "what changed since the last reply"
    components/            rail · workspace (question, editor, copilot, diff, console) · views
    data/                  questions bank, chip definitions
voice/
  server.py                the sidecar
  test_client.py           mic-less end-to-end test
  models/                  Smart Turn v3.2 (ONNX) + feature extractor
scripts/                   smoke, unit tests, behaviour checks, log reader, demo recorder
```

## Data on disk

Under Electron's `userData` directory (`%APPDATA%/prep-copilot` on Windows):

| File | Contents |
|---|---|
| `settings.json` | provider, model, help style, ghost text, voice, budget |
| `playgrounds/` | one file per saved attempt |
| `usage.jsonl` | every model call with real token counts |
| `turns.jsonl` | every chat/voice turn: code snapshot, cursor, diff, history, reply, timing |
| `logs/` | `main.log`, per-session event logs, conversation logs |

Nothing leaves your machine except the prompts sent to the model provider you selected.
