# Spend brakes and costs

## Why they exist

Voice loops can get expensive. During development a session burned about **9 million tokens in 20 minutes**: the mic heard the assistant through the speakers, the VAD called it speech, the speech-to-text transcribed *the assistant*, that became a new "user" turn, the assistant answered, and so on every second or two, with nothing to stop it. These guards exist so that cannot happen again.

## What protects you

| Brake | Behaviour |
|---|---|
| **Cheap default** | Haiku 4.5 is the default chat model; Sonnet is opt-in (Settings → Spend controls). |
| **Rate brake** | More than 8 chat turns in 60 s: calls are refused, the mic is switched off, and a red notice appears in the copilot header. |
| **Daily budget** | Default $2, estimated from list prices in `usage.jsonl`. Calls are refused when it is reached. |
| **Echo guard** | A transcript whose words are at least 70 % what the assistant said in the last 20 s is dropped. |
| **Prompt caps** | Last 10 messages and 12k characters of code per call. |
| **Spend meter** | Real token counts from the API, shown in the copilot header. Every call is appended to `usage.jsonl`. |
| **Master switch** | **AI on/off** in the copilot header. |

Headphones remain the best echo fix; the guard is the safety net.

## What costs credits

| Action | Provider | Rough size |
|---|---|---|
| A chat or voice turn | active provider | 1.5 to 3k tokens in (the prompt includes the whole file), a few hundred out |
| An Agent chip | active provider | same; diff chips up to 2k out |
| Ghost text (each pause ≥ 350 ms while typing) | Groq when a key exists, else the active provider | about 800 in / ≤160 out |
| `npm run smoke` | Anthropic ×3 + Groq ×1 | about 10k tokens; do not loop it |
| Voice STT/TTS | none | local Parakeet; Edge TTS is free |

If a turn fails with `credit balance is too low`, that is the Anthropic prepaid balance, not a rate limit. The exact provider error is logged and shown in the chat bubble.
