# Contributing to CookTrace

Pre-1.0 — the foundation is still being laid out. Issue/PR triage may be
slow until Phase 1 (Recipes) ships. Bug reports are welcome on the public
repo; feature suggestions tracked in [FUTURE.md](FUTURE.md).

## Local dev

```bash
git clone https://github.com/traceapps/cooktrace.git
cd cooktrace
npm install
npm run dev          # Vite dev server on :5175
node server/index.js # API on :3001
```

## Style

- Match the surrounding code. The codebase inherits NutriTrace conventions
  almost entirely.
- No comments unless the WHY is non-obvious.
- Don't add features beyond what the issue/PR scope demands.
- See `CLAUDE.md` for project-specific notes.

## Translations

Adding a new language is a four-step PR:

1. Copy `src/i18n/en.json` to `src/i18n/<your-locale>.json` (e.g. `fr.json`, `de.json`, `pt-BR.json`) and translate the values. Leave the keys untouched. HTML / Markdown inside values (`<strong>`, `<br>`, etc.) stays as-is.
2. Register the locale in `src/i18n/index.js`. Add a `register('<locale>', () => import('./<locale>.json'));` line, and append an `{ code: '<locale>', label: '<Language name in its own language>' }` entry to `AVAILABLE_LOCALES`. Without this step the JSON sits in the repo but the language picker in Settings cannot surface it.
3. Run `npm run i18n:check` and confirm 100% key coverage with no missing or orphaned entries.
4. Open a PR. Translations are merged with the contributor's authorship preserved on the JSON file.

## Brand cohesion

CookTrace, NutriTrace, and LiftTrace share design language and the
`Trace` AI assistant persona. Keep `TraceFace.svelte` identical across
all three repos. If you change the assistant tone or the navigation
chrome here, mirror to LiftTrace + NutriTrace in the same PR cycle.
