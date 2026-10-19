# Copilot behaviour

## What the model sees

Every chat or voice turn ships the file **with line numbers, a ▶ on the caret line, the caret position and the current selection** (`renderEditor` in `src/main/services/prompts.ts`). "What line am I on?" has a real answer. Each turn also carries a `+/-` diff of the editor since the assistant's previous reply (`describeChanges` in `lib/diffLines.ts`), so it sees what you *changed*, not only the latest snapshot. There is nothing to save: the live buffer is read at the moment you send, or finish speaking.

Every turn is written to `turns.jsonl` with the exact snapshot, so "it didn't see my change" can be checked against what the model was actually shown.

## Highlight-first

Selected lines are marked `▌` in the listing the model sees, and the exact selected text is quoted with "when they say *this* they mean this". The panel header shows `Sel L3–7` and `Ln, Col`, so you can see what the copilot sees. Chips such as "Explain lines 3–6" scope to the selection.

## Local voice and chat intents

Navigation never waits on a model. These run locally and instantly (`parseNavIntents`, `src/shared/voiceIntents.ts`):

- "go to line 12"
- "highlight lines 3 to 7", "select line 5"

If a message is only navigation, the model is not called at all. "Highlight 3 to 7 **and explain it**" highlights first, then asks.

## Editor commands

When you ask the model to type or change something, it wraps code in command blocks. The renderer strips them from what is shown and spoken, so the voice never reads code aloud.

| Block | Effect |
|---|---|
| `<<<INSERT>>> … <<<END>>>` | typed at your caret, undoable with Ctrl+Z |
| `<<<REPLACE>>> … <<<END>>>` | goes through the Accept / Reject diff |
| `<<<GOTO>>>12<<<END>>>` | moves the caret |
| `<<<SELECT>>>4-6<<<END>>>` | highlights lines |

## Help styles

Switch any time from the copilot header.

| Style | Behaviour |
|---|---|
| **Coach** | Hints and explanations. No full solution until you say "I give up". |
| **Guided** | One small step at a time, then waits for you. |
| **Pair** | Does what you ask, including writing code. Never volunteers the answer. |
| **Listen** | Stays in the background. Only answers direct questions. |

## Agent chips

Ten one-click actions in Agent mode: Explain problem, Get hints, Idea map, Generate code, Add test cases, Lint code, Complete code, **Optimize solution**, Check code logic, Related problems. Each sees the problem and your live buffer. Chips that change code (such as Optimize) return a diff you Accept or Reject; results also land in the chat thread and are read aloud when the mic is on.

## Ghost text

Inline completions use Monaco's inline-completions provider: 350 ms debounce, **Tab** accepts.

- Requests go to Groq when it has a key (fastest), otherwise the active provider.
- The prompt includes your last six chat or voice turns, so the suggestion follows what you just agreed on with the coach.
- When the caret is inside a `#`, `//`, `/* */` or docstring line, the model is asked for prose that finishes the comment, not code.
- Style, colour, how many lines and scope are configurable in Settings and from the editor tab bar.

## Questions and modes

- **Library:** 14 seeded problems; "Open" switches the workspace, "Practice" starts a saved attempt.
- **Playgrounds:** every attempt is its own file. "New playground" picks a problem you have not started.
- **Free coding:** no problem statement; a notes box ("what I'm working on") is sent with every turn instead.
- **Template vs. starter:** one click swaps the buffer between a blank signature and the starter attempt (e.g. Two Sum's brute force to optimise).
- **Read aloud:** the speaker button next to the title reads the problem through the voice pipeline with no model call.

## Provider notes

| Provider | Model | Note |
|---|---|---|
| Anthropic | Haiku 4.5 by default; Sonnet opt-in | streamed over SSE |
| Groq | `openai/gpt-oss-120b` | sent with `reasoning_effort: low`, otherwise it can return an empty string |
| Gemini | `gemini-flash-latest` | alias tracks the current flash model |
