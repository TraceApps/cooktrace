# Contributing to CookTrace

Pre-1.0 — the foundation is still being laid out. Issue/PR triage may be
slow until Phase 1 (Recipes) ships. Bug reports are welcome on the public
repo; feature suggestions tracked in [FUTURE.md](FUTURE.md).

## Local dev

```bash
git clone https://github.com/traceapps/cooktrace.git
cd cooktrace
npm install
npm run dev          # Vite dev server on :5173
node server/index.js # API on :3001
```

## Style

- Match the surrounding code. The codebase inherits NutriTrace conventions
  almost entirely.
- No comments unless the WHY is non-obvious.
- Don't add features beyond what the issue/PR scope demands.
- See `CLAUDE.md` for project-specific notes.

## Pull requests

- **Target the `dev` branch, not `main`.** All work lands on `dev` first, gets tested there, and is bundled into `main` at release time. PRs opened against `main` will be asked to retarget.
- Keep changes focused — one concern per PR.
- Update `CHANGELOG.md` under the unreleased section if your change is user-visible.
- The Android shell lives in `android/`; if you change web assets the maintainer will run `npx cap sync android` and rebuild the APK.
- No DCO or CLA required.

## Translations

### For translators — adding a new language

1. Copy `src/i18n/en.json` to `src/i18n/<your-locale>.json` (e.g. `fr.json`, `de.json`, `pt-BR.json`) and translate the values. Leave the keys untouched. HTML / Markdown inside values (`<strong>`, `<br>`, etc.) stays as-is.
2. Register the locale in `src/i18n/index.js`. Add a `register('<locale>', () => import('./<locale>.json'));` line, and append an `{ code: '<locale>', label: '<Language name in its own language>' }` entry to `AVAILABLE_LOCALES`. Without this step the JSON sits in the repo but the language picker in Settings cannot surface it.
3. Run `npm run i18n:check` and confirm 100% key coverage with no missing or orphaned entries.
4. Open a PR. Translations are merged with the contributor's authorship preserved on the JSON file.

### For code contributors — instrumenting new strings

Every user-facing string added to the app should be extracted into `en.json` and rendered through `svelte-i18n`'s `$_()` helper. Hardcoded English literals in templates are the reason translation coverage lags the codebase — please prevent them at PR time rather than retrofit them later.

The pattern:

```svelte
<script>
  import { _ } from 'svelte-i18n';
</script>

<h1>{$_('routes.recipes.title')}</h1>
<input placeholder={$_('routes.recipes.search_placeholder')} />
```

Then in `src/i18n/en.json`:

```json
"routes": {
  "recipes": {
    "title": "Recipes",
    "search_placeholder": "Search recipes…"
  }
}
```

Guidelines:

- **Group by area**, not by page. `settings.notifications.section` is better than `settings_notifications_section`.
- **Only add English** in your PR. Do not machine-translate or hand-translate into other languages you don't natively speak — that misrepresents contributor work. The `en.json` addition is enough; translators fill in their locale files in follow-up PRs. `svelte-i18n`'s `fallbackLocale: 'en'` renders English until a translation lands.
- **Skip developer-facing strings** — error stacks, log messages, JSON payload keys, class names. Only pull out what a user reads on screen.
- **Interpolation** uses `{$_('key', { values: { name: user.name } })}` and `{name}` in the JSON value. Prefer this over string concatenation so translators can reorder words.
- **Run `npm run i18n:check`** before opening the PR. It flags orphaned keys and missing translations across every locale file, catching typos and stale entries.

If you're adding a section that has a lot of copy, group all the new keys under one namespace in `en.json` so they can be reviewed together.

### On putting words in a contributor's mouth

Do not add translations for locales you don't natively speak, and do not merge machine-translated content into a contributor's locale file. If a section can't be translated at code-write time (nobody on the PR speaks the language), extract to `en.json`, open a follow-up "Translations wanted" issue linking the new keys, and let a native speaker fill them in. `svelte-i18n`'s English fallback keeps the app fully functional in the meantime.

## Brand cohesion

CookTrace, NutriTrace, and LiftTrace share design language and the
`Trace` AI assistant persona. Keep `TraceFace.svelte` identical across
all three repos. If you change the assistant tone or the navigation
chrome here, mirror to LiftTrace + NutriTrace in the same PR cycle.
