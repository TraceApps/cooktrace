# Architecture

Orientation for new contributors. Covers the shape of the codebase,
the design decisions worth knowing before touching things, and the
house conventions that aren't obvious from reading the source.

## Stack

- **Frontend:** Svelte 4 (compat mode on Svelte 5 runtime), Vite,
  svelte-spa-router v4 (hash routing)
- **Server:** Node + Express 5, better-sqlite3
- **Mobile:** PWA + Capacitor 8 (Android)
- **Deploy:** `docker compose up -d`, serves on port 3003 (host and container)

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
- `android/wear/src/main/java/com/cooktrace/app/wear/`, the Wear OS app: `Kitchen.kt` (parsing and the decisions the watch makes on its own), `CookStore.kt` (state plus the outbox), `Pairing.kt` (prefs, cache and the Wearable Data Layer), `CookApi.kt`

Everything else is discoverable with `grep` and `ls`.

## The watch is a client, not a satellite

`android/wear` is a standalone Wear OS app that talks to the server itself
over the same REST routes the phone and browser use. The phone hands over the
address and a token through the Wearable Data Layer and nothing is typed on
the watch. Both APKs must carry the same package name and signing certificate
or the Data Layer silently carries nothing.

Three paths cross the Data Layer, each one record per device, each stamped by
the clock of whoever wrote it, newest wins, and a deletion is the Data Layer
tidying up after a device rather than a signal to act on:

- `/cooktrace/pairing`, the server address and token
- `/cooktrace/cook`, the cooks underway and what has been ticked off each,
  by the id the **server** uses and never this phone's own local id
- `/cooktrace/timers`, what is counting down, matched by a key that outlives
  both the watch's small alarm ids and a deadline that moves when extended,
  and shared only while a cook has been handed over

Anything that has to happen with the app off the screen is an AlarmManager
exact alarm carrying a deadline, never something counting; anything repeating
on screen is inside `repeatOnLifecycle(RESUMED)`. Every write to the Data
Layer starts the watch app's listener service, so bursts are coalesced rather
than sent per tap.

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

### Two edits of one row: the newer edit of each field

When the same row is changed in two places (the phone offline, the web, a
second phone), the server keeps the newer edit of each field, not of the
whole row, with the rule every Trace app shares (`server/lib/field-sync.js`,
the same file in `src/lib`, pinned by `scripts/field-sync.test.js`): fields
that belong together stay together (`server/lib/sync-fields.js`
`SYNC_GROUPS`), a delete made before a later edit loses, an edit made
before a delete doesn't bring the row back, and times count in whole
seconds (a tie between two edits goes to the one arriving, between an
edit and a delete to the delete).

- Each synced row keeps `field_stamps` (`{ field: [synced_at, edited_at] }`,
  server only), kept by triggers in `db.js` and set per field by a merged
  edit (`server/lib/field-stamps.js` `stampEach`). No answer carries it
  (`server/lib/private-fields.js`); a full backup does, and a restore keeps it.
- `server/lib/field-merge.js` puts CookTrace's own check in front of the
  shared rule: an edit says which copy it was made on (the server's
  `synced_at` of it), and a field not changed here since that copy is the
  edit's to change, whatever the clocks say. Only a field changed here too
  is decided by time. An edit whose time can't be right goes in, at the
  time it arrives. A recipe's content that doesn't stay is kept as an
  earlier version (`server/lib/recipe-versions.js`).
- An edit says when each field it changed was changed (`field_edits`, on a
  pushed row and in a web save's `_sync`), so a field changed before a
  later change of another keeps its own time. The Android app keeps them in
  `edit_times` (triggers in `src/lib/db-native.js`, cleared once the row's
  push lands); the web app's queue keeps each queued save's time when two
  saves of one row go up as one (`src/lib/offline-edits.js`
  `combineSaveBases`). Apps and servers from before send or read none, and
  every field an edit changed counts at the edit's time, as before.

### Only the app's own addresses get CORS

`server/lib/cors.js` (identical in all four Trace apps) decides which pages
on another address may call the API with the person's sign-in. Allowed: the
Android app's WebView (`https://app.cooktrace.local`, and
`https://localhost` from versions before it) and the address in
`PUBLIC_URL`, each compared whole: scheme, host and port. Anything else gets
no CORS headers. The web app calls its own address, which needs none;
the API, MCP and the watch app send no Origin.

### Changes from another site are refused

`server/lib/cross-site.js` (identical in all four Trace apps) runs before
every route: a request that changes something (any method but GET, HEAD and
OPTIONS) passes only when the browser's `Sec-Fetch-Site` is `same-origin` or
`none`, or its `Origin` is one CORS allows (above) or exactly the request's
own address (from `X-Forwarded-Proto` and `X-Forwarded-Host`, or Host), or
it carries neither header (the Android app's native code, the watch app,
MCP, the API, scripts, the other Trace apps' servers). Browsers always send
`Origin` on these methods (`null` from a sandboxed frame or a page that
sends no referrer), and a page can't change it, so a page on any other
address, on the same site or not, can't send a form, a no-cors fetch or an
upload that changes anything, with or without the sign-in cookie. Anything
else gets a 403 (`code: "cross_site"`) and one warning in the log per
address. Behind a proxy that passes neither the public `Host` nor
`X-Forwarded-Host`, writes need `PUBLIC_URL` over plain http (no browser
sends `Sec-Fetch-Site` there) and, over https, from older browsers without
it (such as Safari before 16.4). It can't tell apart apps that share one
origin (two apps under subpaths of the same host), and a DNS rebinding page
counts as the app's own address.

The CSRF token (`server/middleware/csrf.js`) still guards signed-in
sessions; this also covers a server without accounts, which has no sign-in
for a token to protect.

### The installed web app loads from the server first

The service worker precaches the built app. Page loads go to the server first
and fall back to the precached `index.html` offline, after 3 seconds, or on a
5xx from a proxy, and nothing is stored from them, so a reload after a deploy
gets the new app and a sign-in proxy can show its page
(`src/lib/pwa-navigation.js`, notetrace#37). The API, uploads and public
recipe links (`/r/<token>`) always go to the server. None of them is kept from a page
load (`NetworkOnly`), so an export or a backup can't outlive the session, and
`public/sw-retired-caches.js` deletes the old `pages-cache` that held them.

### A server that doesn't answer counts as offline

The web app's offline layer (`src/lib/offline-api.js`) answers reads from an
IndexedDB copy and queues changes when the server can't be reached.
A server that takes the connection and never answers fails no request, so
each request with an offline answer gets a deadline for the server's first
answer (a long body still downloads at its own pace)
(`src/lib/request-deadline.js`, the same file in the four Trace apps): the
sign-in check at startup with an account kept here (3 s), a read (4 s: the
copy answers, or it says it needs a connection, as with none; 10 s for the
reads the app names heavy, whole lists and stats, for a small server with a
big account). One that runs out counts as no connection (`err.offline`),
and the server counts as quiet for 20 s: reads wait 1.5 s, and changes go
into the outbox without being sent, unless one sent before is still waiting
(`queueUnsent`), so the older one can't land last over it. A change that is sent (and the outbox's
replay) has no deadline, as before: one cut off might have landed, and sent
again it could be made twice. Any answer from the server ends that
early, and a read that runs out while quiet doesn't start it again, so a
server slower than 1.5 s is asked at full length when it ends. Reads the app
names slow wait as long as they take: Trace, NoteTrace, food
databases, update checks, exports and backups (`readDeadlineMsFor()` in
`offline-api.js`). Anything that isn't a read or a change it can queue
(sharing, kitchens, imports, AI) waits as long as it takes.


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
