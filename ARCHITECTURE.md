# Architecture

Orientation for new contributors. Covers the shape of the codebase,
the design decisions worth knowing before touching things, and the
house conventions that aren't obvious from reading the source.

## Stack

- **Frontend:** Svelte 4 (compat mode on Svelte 5 runtime), Vite,
  svelte-spa-router v4 (hash routing)
- **Server:** Node + Express 5, better-sqlite3
- **Mobile:** PWA + Capacitor 8 (Android)
- **Deploy:** `docker compose up -d`, serves on port 3000

## Layout

The important reads:

- `src/App.svelte`, root, all routes wired here
- `src/lib/api.js`, API proxy that picks between HTTP, native SQLite,
  and cached impls per platform
- `src/lib/db.js`, IndexedDB for PWA settings storage
- `src/lib/db-native.js`, on-device SQLite for Android local mode
- `src/lib/sync.js`, push/pull orchestrator for Android server mode
- `server/db.js`, schema, migrations, sole SQLite entry point
- `server/routes/`, Express handlers, one file per domain
- `src/routes/`, top-level Svelte page components

Everything else is discoverable with `grep` and `ls`.

## Key Design Decisions

Things you'd want to know before rewriting them.

### Routing re-mounts on nav

`{#key $location}` in App.svelte forces route components to
destroy/recreate on every nav so `onMount` fires fresh each time.
Intentional. If you strip this, half the page-transition and
skeleton-loader UX breaks.

### Pantry is the canonical ingredient catalog

Every recipe ingredient row references a `pantry_items` row. Names
auto-create pantry rows on recipe save (case-insensitive dedup) so the
catalog grows organically. This is what enables the "8/10 in pantry"
pill on every recipe card, federation lookups, and shopping-list
dedup across recipes.

### Energy unit is independent of measurement system

Kept separate because most metric countries (UK, EU, Canada) still
use kcal, while AU/NZ are the kJ outliers. Both default to kcal;
AU/NZ users flip the toggle. Auto-detects from `navigator.language`.
Stored values are always kcal; conversion is display-only via
`displayEnergy()` / `energyLabel()`.

### Sodium and salt auto-derive

Server-side in `recipes._toStorage` using factor 400 (EU regulatory
rounding). Tagged with `_derived.salt|sodium` so the UI can show a
calculator-icon badge on the derived value.

### Cook Mode state is local-only

Ingredient/step checkboxes live in `localStorage` keyed
`ct:checks:<recipeId>:ing|step`. Survives reload but intentionally
doesn't sync across devices. Wake Lock re-acquires on tab visibility
return so the screen stays on through brief tab switches.

### URL scraper is SSRF-guarded

http(s) only, blocks loopback/private IPs, 8s timeout, 5MB cap.
User-Agent identifies as CookTrace. Anything you add to the scraper
path needs to preserve these guarantees.

### Recipe-card share is SVG, not raster

Every modern browser and Slack/Discord/iMessage handles
`image/svg+xml`. Avoids a server-side Canvas/Sharp dependency, which
would balloon the Docker image.

### Federation with NutriTrace goes through the server

`/api/nt/*` is a proxy layer. Browser calls our server; server
forwards to NutriTrace with the bearer token. The federation token
never leaves the server. Configure URL + token in Settings, then
NutriTrace federation.

### Pantry variants are a three-shape hierarchy

A `pantry_items` row is one of:

- **flat**: no parent, no children
- **generic**: no parent, has variants pointing at it
- **variant**: has a parent

Recipes link to the generic. The generic can carry its own nutrition
or defer to whichever child is its `nutrition_source_variant_id`.
Three-level nesting is server-rejected. Delete on a generic offers
Keep Variants (variants get promoted to standalone) or Remove All
(cascade). See `src/lib/pantry-variants.js` for the shared helpers.

### Recipe Rest + Total time

`rest_minutes` is the generic hands-off slot (rise / rest / marinate
/ chill / soak / ferment / cure). `total_minutes` is an optional
manual override; when NULL the auto-calc is `prep + cook + rest`.
Every display helper reads the same
`r.total_minutes ?? prep + cook + rest` fallback via
`formatDuration()`. Importers capture `rest_minutes` when the source
names a hands-off period distinctly.

### Native sync semantics

Order is **pull-then-push** so mobile refreshes against the server's
latest state before propagating local changes. Server-side push uses
`COALESCE(?, existing)` on FK columns so a stale mobile payload
can't clobber a newer server value. Client `updatePantryItem` only
writes the fields the payload contains; writing every column on
every partial update silently wiped FKs.

## Android Local Mode

CookTrace on Android runs **standalone (offline-only)** or
**server-connected**, at the user's choice. First-launch wizard at
`src/routes/NativeSetup.svelte` picks the mode; Settings then Server
Connection changes it later.

- **Mode toggle:** `ct:nativeMode` in localStorage
  (`'local' | 'server' | null`)
- **Dispatch:** `src/lib/api.js` Proxy picks `_CtApiHttp` (PWA),
  `CtApiNative` (native local), or `CtApiCached` (native + server)
- **Local SQLite:** `src/lib/db-native.js`. Schema mirrors every
  server table, plus `server_id` + `sync_status` columns for sync
  bookkeeping
- **Local CRUD:** `src/lib/api-native.js`
- **Cached impl:** `src/lib/api-cached.js` wraps native + triggers
  debounced background push after every write
- **Sync orchestrator:** `src/lib/sync.js`. 30s background timer +
  visibilitychange resume hook. Server endpoints at
  `/api/sync/push` and `/api/sync/pull`
- **Local backup:** `src/lib/local-backup.js` dumps every SQLite
  table + base64-inlined images to a single JSON file. Wired into
  Settings, Backup, Export JSON in local mode

## Conventions

- **localStorage prefix:** `ct:` (cookies, csrf, cached user)
- **Per-user settings key:** `wl_u<id>_<key>` (legacy from waistline,
  intentional)
- **Auth cookie:** `ct_token`
- **Runtime config:** `__CT_CONFIG__` injected on `window`
- **Deep-link scheme:** `cooktrace://`
- **Android app id:** `com.cooktrace.app`
- **Comments:** state the non-obvious constraint or say nothing.
  Skip comments that restate the next line

## Build & Release

```bash
npm run dev                    # local dev server
npm run build                  # PWA build to dist/
npm run android:build          # vite build + cap sync android
npm run android:apk:debug      # debug APK, no keystore
npm run android:apk:release    # release APK (needs keystore.properties)
```

`android/keystore.properties` (gitignored) configures release signing.
Debug and release builds sign with the same keystore so swapping
between them doesn't trigger Android's signature-mismatch reinstall,
which wipes the local SQLite DB.

## Related Docs

- [`ROADMAP.md`](ROADMAP.md), what's planned, what's shipped
- [`CHANGELOG.md`](CHANGELOG.md), per-release notes
- [`CONTRIBUTING.md`](CONTRIBUTING.md), how to open a PR, i18n rules
