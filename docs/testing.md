# Testing and debugging

## Commands

| Command | Needs keys? | What it covers |
|---|---|---|
| `npm run typecheck` | no | main/preload and renderer TypeScript |
| `npm run lint` | no | ESLint over `src/` |
| `npm test` | no | unit tests for inline-completion logic and voice intents |
| `npm run smoke` | yes | the **built** app under Playwright: layout, real Python run, streamed AI chat, editor commands, inline completion, new playground, library Open, voice sidecar start and WebSocket, Optimize diff → Accept. Run `npm run build` first. |
| `node scripts/coach-check.mjs` | yes | real-model check of the coach rules on situations taken from real sessions |
| `node scripts/copilot-ui-check.mjs` | yes | copilot panel UI behaviour |
| `node scripts/ghost-check.mjs` | yes | ghost text end to end |
| `npm run demo` | yes | records the README demo (`DEMO_PROVIDER`, `OUT_DIR` env vars) |

The behaviour checks and the demo recorder use a **throwaway profile** (`--user-data-dir`), so your settings, playgrounds and logs are untouched.

## Reading logs

Each run writes a structured session log and a conversation log. Read them with the helper instead of opening files by hand:

```bash
npm run logs -- list
npm run logs -- summary latest
npm run logs -- errors
npm run logs -- turns --last 5
npm run logs -- voice --around 120000 --window 10
npm run logs -- grep bargein
```

Output is capped on purpose; pass `--limit` to widen it, or set `PREP_LOG_DIR` to read logs from elsewhere.

## Debugging in the app

- **Debug** menu, or Settings → Debug: open DevTools, show the log path.
- `npm run debug` starts with `--inspect=5858` (attach VS Code or `chrome://inspect`) and `--remote-debugging-port=9222`.
- Everything the Python sidecar prints goes into the main log under `voice:py`.
- To find a stray sidecar: `netstat -ano -p tcp | findstr 127.0.0.1`, then kill the Python PID that is listening.
