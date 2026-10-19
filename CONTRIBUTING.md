# Contributing

Thanks for taking a look. Prep is a personal project that is now open source; small, focused PRs are very welcome.

## Setup

```bash
npm install
cp .env.example .env     # add at least one API key to run the app itself
npm run dev
```

Voice setup is optional and covered in [docs/voice.md](docs/voice.md).

## Before you open a PR

```bash
npm run typecheck && npm run lint && npm test
```

These need no API keys. If you changed copilot, ghost-text or voice behaviour, also run `npm run build && npm run smoke` and say so in the PR. Smoke makes a few small model calls.

## Guidelines

- **Keys never leave the main process.** Anything that needs a secret goes through IPC from `src/main`.
- Match the surrounding code's style and comment density.
- Prefer a small test in `scripts/*.test.mjs` for pure logic.
- Do not commit `.env`, logs, or recordings that show keys. Screenshots in `docs/media` are made with `scripts/record-demo.mjs` on a throwaway profile; please do the same.
- For larger changes, open an issue first so we can agree on the approach.

## Reporting security issues

If you find a leaked secret or a way to reach the renderer from untrusted content, open a private security advisory on GitHub rather than a public issue.
